import base64
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

from PIL import Image


SERVICE_PATH = Path(__file__).resolve().parents[1] / "server.py"
SPEC = importlib.util.spec_from_file_location("local_ocr_server", SERVICE_PATH)
service = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(service)
EXT_ID = "abcdefghijklmnopabcdefghijklmnop"
ORIGIN = "chrome-extension://" + EXT_ID


def image_data(fmt="PNG", size=(180, 50)):
    output = io.BytesIO()
    Image.new("RGB", size, "white").save(output, format=fmt)
    return output.getvalue()


class FakeEngine:
    def __init__(self, result="ABCDEF", error=None):
        self.result, self.error = result, error
        self.images = []

    def classification(self, image, **kwargs):
        self.images.append((image, kwargs))
        if self.error:
            raise self.error
        return self.result


class FakeSocket:
    def __init__(self, request):
        self.request = io.BytesIO(request)
        self.response = io.BytesIO()

    def makefile(self, *_args):
        return self.request

    def sendall(self, data):
        self.response.write(data)

    def settimeout(self, _seconds):
        pass


def request(method="GET", path="/health", headers=None, body=b"", engine=None,
            recognizer=None, default_headers=True):
    pairs = [("Host", "127.0.0.1:8765"), ("X-NOL-Extension-Id", EXT_ID)] if default_headers else []
    pairs += headers or []
    if body and not any(key.lower() == "content-length" for key, _ in pairs):
        pairs.append(("Content-Length", str(len(body))))
    raw = (method + " " + path + " HTTP/1.1\r\n" +
           "".join(key + ": " + value + "\r\n" for key, value in pairs) + "\r\n").encode() + body
    connection = FakeSocket(raw)
    server = types.SimpleNamespace(recognizer=recognizer or service.Recognizer(engine or FakeEngine()))
    # Exercise the actual HTTP parser and Handler without binding any TCP port.
    with contextlib.redirect_stdout(io.StringIO()) as stdout, contextlib.redirect_stderr(io.StringIO()) as stderr:
        service.Handler(connection, ("127.0.0.1", 10000), server)
    assert not stdout.getvalue() and not stderr.getvalue(), "request handler must not log"
    header_bytes, response_body = connection.response.getvalue().split(b"\r\n\r\n", 1)
    lines = header_bytes.decode().split("\r\n")
    return int(lines[0].split()[1]), dict(line.split(": ", 1) for line in lines[1:]), json.loads(response_body)


def recognize_request(payload=None, **kwargs):
    payload = payload if payload is not None else {"image": base64.b64encode(image_data()).decode()}
    return request("POST", "/recognize", headers=[("Content-Type", "application/json")],
                   body=json.dumps(payload).encode(), **kwargs)


class HTTPTests(unittest.TestCase):
    def test_health_without_origin_requires_extension_header(self):
        status, headers, payload = request()
        self.assertEqual(status, 200)
        self.assertEqual(payload["engine"], "ddddocr")
        self.assertEqual(payload["version"], "1.6.1")
        self.assertNotIn("Access-Control-Allow-Origin", headers)
        self.assertEqual(headers["Cache-Control"], "no-store")

    def test_matching_extension_origin_is_echoed(self):
        status, headers, _ = request(headers=[("Origin", ORIGIN)])
        self.assertEqual(status, 200)
        self.assertEqual(headers["Access-Control-Allow-Origin"], ORIGIN)
        self.assertNotIn("Access-Control-Allow-Credentials", headers)

    def test_web_null_or_mismatched_origins_cannot_use_service(self):
        for origin in ("https://world.nol.com", "http://127.0.0.1:8765", "null",
                       "chrome-extension://" + "a" * 32, ORIGIN + "/"):
            with self.subTest(origin=origin):
                status, headers, payload = request(headers=[("Origin", origin)])
                self.assertEqual(status, 403)
                self.assertEqual(payload["code"], "ORIGIN_DENIED")
                self.assertNotIn("Access-Control-Allow-Origin", headers)

    def test_missing_invalid_duplicate_extension_header_is_rejected(self):
        for extra in ([], [("X-NOL-Extension-Id", "invalid")],
                      [("X-NOL-Extension-Id", EXT_ID), ("X-NOL-Extension-Id", EXT_ID)]):
            with self.subTest(extra=extra):
                status, _, payload = request(headers=[("Host", "127.0.0.1:8765")] + extra,
                                             default_headers=False)
                self.assertEqual(status, 403)
                self.assertEqual(payload["code"], "EXTENSION_ID_REQUIRED")

    def test_host_must_be_exact_loopback_port_once(self):
        for hosts in (["localhost:8765"], ["evil.example:8765"], ["127.0.0.1:8766"],
                      ["127.0.0.1:8765", "127.0.0.1:8765"]):
            with self.subTest(hosts=hosts):
                status, _, payload = request(headers=[("Host", value) for value in hosts] +
                                             [("X-NOL-Extension-Id", EXT_ID)], default_headers=False)
                self.assertEqual(status, 403)
                self.assertEqual(payload["code"], "HOST_DENIED")

    def test_valid_extension_preflight_does_not_need_value_header(self):
        status, headers, payload = request("OPTIONS", "/recognize", default_headers=False,
            headers=[("Host", "127.0.0.1:8765"), ("Origin", ORIGIN),
                     ("Access-Control-Request-Method", "POST"),
                     ("Access-Control-Request-Headers", "content-type, x-nol-extension-id")])
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertEqual(headers["Access-Control-Allow-Origin"], ORIGIN)
        self.assertEqual(headers["Access-Control-Allow-Headers"], "Content-Type, X-NOL-Extension-Id")

    def test_preflight_rejects_web_origins_or_extra_headers(self):
        for origin, requested in (("https://evil.example", "content-type, x-nol-extension-id"),
                                  ("null", "content-type, x-nol-extension-id"),
                                  (ORIGIN, "content-type"),
                                  (ORIGIN, "content-type, x-nol-extension-id, authorization")):
            with self.subTest(origin=origin, requested=requested):
                status, _, _ = request("OPTIONS", "/recognize", headers=[("Origin", origin),
                    ("Access-Control-Request-Method", "POST"),
                    ("Access-Control-Request-Headers", requested)])
                self.assertEqual(status, 403)

    def test_exact_paths_and_methods_only(self):
        for path in ("/health?image=secret", "/recognize/", "/arbitrary", "http://evil.example/health"):
            with self.subTest(path=path):
                status, _, payload = request(path=path)
                self.assertEqual(status, 404)
                self.assertEqual(payload["code"], "NOT_FOUND")
        status, _, payload = request("GET", "/recognize")
        self.assertEqual((status, payload["code"]), (405, "METHOD_DENIED"))

    def test_valid_image_returns_candidate_but_not_confidence_or_submission(self):
        engine = FakeEngine("abcDEF")
        status, _, payload = recognize_request(engine=engine)
        self.assertEqual(status, 200)
        self.assertEqual(payload["candidate"], "ABCDEF")
        self.assertEqual(payload["raw"], "ABCDEF")
        self.assertTrue(payload["recognized"])
        self.assertIsNone(payload["confidence"])
        self.assertEqual(len(engine.images), 1)
        self.assertEqual(engine.images[0], (image_data(), {"png_fix": True}))

    def test_invalid_engine_output_cannot_become_six_letters_by_dropping_digits(self):
        for text in ("ABCDE", "ABCDEFG", "ABC1DEF", "ABC DEF", "", "ABC\nDEF"):
            with self.subTest(text=text):
                status, _, payload = recognize_request(engine=FakeEngine(text))
                self.assertEqual(status, 200)
                self.assertFalse(payload["recognized"])
                self.assertEqual(payload["candidate"], "")
                self.assertEqual(payload["code"], "OCR_NOT_SIX_LETTERS")

    def test_engine_error_and_unexpected_output_return_fixed_errors(self):
        for engine in (FakeEngine(error=RuntimeError("SECRET_IMAGE_SESSION_RESULT")),
                       FakeEngine({"text": "ABCDEF"}), FakeEngine("a" * 65)):
            status, _, payload = recognize_request(engine=engine)
            self.assertEqual(status, 500)
            self.assertNotIn("SECRET", json.dumps(payload))
            self.assertEqual(payload["candidate"], "")

    def test_json_base64_schema_or_arbitrary_url_is_rejected_before_ocr(self):
        for value in ({}, {"image": "https://evil.example/a.png"}, {"image": "data:image/png;base64,AAAA"},
                      {"image": True}, {"image": "@@@"}, {"image": ""},
                      {"image": "AAAA", "url": "https://evil.example"}, []):
            with self.subTest(value=value):
                engine = FakeEngine()
                status, _, _ = recognize_request(value, engine=engine)
                self.assertEqual(status, 400)
                self.assertEqual(engine.images, [])

    def test_missing_duplicate_content_length_chunked_or_wrong_type_is_rejected(self):
        cases = [([], 415), ([("Content-Type", "text/plain"), ("Content-Length", "1")], 415),
                 ([("Content-Type", "application/json")], 400),
                 ([("Content-Type", "application/json"), ("Content-Length", "-1")], 400),
                 ([("Content-Type", "application/json"), ("Content-Length", "1"), ("Content-Length", "1")], 400),
                 ([("Content-Type", "application/json"), ("Content-Length", "524289")], 413),
                 ([("Content-Type", "application/json"), ("Content-Length", "9" * 1000)], 413),
                 ([("Content-Type", "application/json"), ("Transfer-Encoding", "chunked")], 400)]
        for headers, expected in cases:
            with self.subTest(headers=headers):
                status, _, _ = request("POST", "/recognize", headers=headers)
                self.assertEqual(status, expected)

    def test_malformed_json_incomplete_body_and_nesting_are_rejected(self):
        for body in (b"not json", b"\xff", b"[" * 2000 + b"]" * 2000):
            status, _, payload = request("POST", "/recognize", headers=[("Content-Type", "application/json")], body=body)
            self.assertEqual((status, payload["code"]), (400, "INVALID_JSON"))
        status, _, payload = request("POST", "/recognize", headers=[("Content-Type", "application/json"),
                                    ("Content-Length", "10")], body=b"{}")
        self.assertEqual((status, payload["code"]), (400, "INCOMPLETE_BODY"))

    def test_concurrent_recognition_returns_busy_without_second_inference(self):
        engine = FakeEngine()
        recognizer = service.Recognizer(engine)
        recognizer.lock.acquire()
        try:
            status, _, payload = recognize_request(recognizer=recognizer)
            self.assertEqual((status, payload["code"]), (409, "OCR_BUSY"))
            self.assertEqual(engine.images, [])
        finally:
            recognizer.lock.release()
        self.assertTrue(recognizer.recognize(image_data())["recognized"])


class ImageAndStartupTests(unittest.TestCase):
    def test_png_jpeg_webp_are_accepted(self):
        for fmt in ("PNG", "JPEG", "WEBP"):
            with self.subTest(fmt=fmt):
                data = image_data(fmt)
                self.assertEqual(service.validate_image({"image": base64.b64encode(data).decode()}), data)

    def test_unsupported_truncated_large_and_animated_images_are_rejected(self):
        animated = io.BytesIO()
        Image.new("RGB", (20, 20), "white").save(animated, format="WEBP", save_all=True,
            append_images=[Image.new("RGB", (20, 20), "black")], duration=100, loop=0)
        cases = [(image_data("BMP"), "UNSUPPORTED_IMAGE"),
                 (image_data()[:40], "INVALID_IMAGE"),
                 (image_data(size=(1025, 10)), "IMAGE_DIMENSIONS"),
                 (image_data(size=(10, 513)), "IMAGE_DIMENSIONS"),
                 (image_data(size=(1024, 1)), "IMAGE_DIMENSIONS"),
                 (b"x" * (service.MAX_IMAGE_BYTES + 1), "IMAGE_TOO_LARGE"),
                 (animated.getvalue(), "ANIMATED_IMAGE")]
        for data, code in cases:
            with self.subTest(code=code):
                with self.assertRaises(service.RequestError) as caught:
                    service.validate_image({"image": base64.b64encode(data).decode()})
                self.assertEqual(caught.exception.code, code)

    def test_model_initialized_once_ranges_set_and_synthetic_image_warmed(self):
        engine = FakeEngine()
        engine.set_ranges = unittest.mock.Mock()
        factory = unittest.mock.Mock(return_value=engine)
        with patch.dict(sys.modules, {"ddddocr": types.SimpleNamespace(DdddOcr=factory)}):
            recognizer = service.load_recognizer()
        factory.assert_called_once_with(show_ad=False, use_gpu=False)
        engine.set_ranges.assert_called_once_with("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")
        self.assertEqual(len(engine.images), 1)
        with Image.open(io.BytesIO(engine.images[0][0])) as warm:
            self.assertEqual(warm.size, (200, 60))
        recognizer.recognize(image_data())
        recognizer.recognize(image_data())
        factory.assert_called_once()
        self.assertEqual(len(engine.images), 3)

    def test_main_always_binds_fixed_loopback(self):
        fake_server = unittest.mock.Mock()
        fake_server.serve_forever.side_effect = KeyboardInterrupt
        with patch.object(service, "load_recognizer", return_value="ready"), \
             patch.object(service, "LocalOCRServer", return_value=fake_server) as factory, \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(service.main(), 0)
        factory.assert_called_once_with(("127.0.0.1", 8765), service.Handler)
        self.assertEqual(fake_server.recognizer, "ready")
        fake_server.server_close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
