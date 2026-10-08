"""Local, transient OCR candidate service. No website access or submission logic."""

import base64
import binascii
import io
import json
import re
import sys
import threading
import unicodedata
import warnings
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from PIL import Image, UnidentifiedImageError


HOST = "127.0.0.1"
PORT = 8765
MAX_REQUEST_BYTES = 512 * 1024
MAX_IMAGE_BYTES = 384 * 1024
MAX_WIDTH = 1024
MAX_HEIGHT = 512
EXTENSION_ID = re.compile(r"[a-p]{32}\Z")
LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
SERVICE_VERSION = "1"


class RequestError(Exception):
    def __init__(self, status, code, reason):
        super().__init__(code)
        self.status, self.code, self.reason = status, code, reason


def validate_image(payload):
    if not isinstance(payload, dict) or set(payload) != {"image"}:
        raise RequestError(400, "INVALID_JSON", "请求只能包含 image 图片字段。")
    encoded = payload["image"]
    if not isinstance(encoded, str) or not encoded:
        raise RequestError(400, "INVALID_BASE64", "图片必须是有限长度的纯 Base64 字符串。")
    if len(encoded) > MAX_REQUEST_BYTES:
        raise RequestError(413, "IMAGE_TOO_LARGE", "图片超过 384 KB。")
    try:
        image_bytes = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        raise RequestError(400, "INVALID_BASE64", "图片 Base64 格式不正确。") from None
    if not image_bytes or len(image_bytes) > MAX_IMAGE_BYTES:
        raise RequestError(413, "IMAGE_TOO_LARGE", "图片为空或超过 384 KB。")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(image_bytes)) as image:
                if image.format not in {"PNG", "JPEG", "WEBP"}:
                    raise RequestError(415, "UNSUPPORTED_IMAGE", "只支持 PNG、JPEG、WebP 图片。")
                width, height = image.size
                if not (1 <= width <= MAX_WIDTH and 1 <= height <= MAX_HEIGHT):
                    raise RequestError(413, "IMAGE_DIMENSIONS", "图片尺寸超过 1024 × 512 像素。")
                if width > height * 20 or height > width * 20:
                    raise RequestError(413, "IMAGE_DIMENSIONS", "图片宽高比例不适合单行验证码识别。")
                if getattr(image, "n_frames", 1) != 1:
                    raise RequestError(415, "ANIMATED_IMAGE", "只支持单帧图片。")
                image.verify()
            # verify() alone does not decode all compressed pixel data.
            with Image.open(io.BytesIO(image_bytes)) as image:
                image.load()
    except RequestError:
        raise
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError,
            Image.DecompressionBombWarning):
        raise RequestError(400, "INVALID_IMAGE", "图片无法完整解码。") from None
    return image_bytes


class Recognizer:
    def __init__(self, engine):
        self.engine = engine
        self.lock = threading.Lock()

    def recognize(self, image_bytes):
        if not self.lock.acquire(blocking=False):
            raise RequestError(409, "OCR_BUSY", "正在识别上一张图片，请稍后再试。")
        try:
            result = self.engine.classification(image_bytes, png_fix=True)
            if not isinstance(result, str) or len(result) > 64:
                raise RequestError(500, "OCR_RESULT_INVALID", "识别引擎没有返回有效文字。")
            raw = unicodedata.normalize("NFKC", result).strip().upper()
            recognized = re.fullmatch(r"[A-Z]{6}", raw) is not None
            return {
                "ok": True,
                "recognized": recognized,
                "candidate": raw if recognized else "",
                "raw": raw,
                "confidence": None,
                "code": "OCR_CANDIDATE" if recognized else "OCR_NOT_SIX_LETTERS",
                "reason": "请核对候选文字后手动提交。" if recognized else "未识别出完整的 6 位英文字母，请手动输入。",
            }
        except RequestError:
            raise
        except Exception:
            # Engine errors may contain image data or user text; never expose them.
            raise RequestError(500, "OCR_FAILED", "本地识别失败，请手动输入。") from None
        finally:
            self.lock.release()


class Handler(BaseHTTPRequestHandler):
    server_version = "NOLLocalOCR"
    sys_version = ""

    def log_message(self, *_args):
        pass

    def setup(self):
        super().setup()
        self.connection.settimeout(8)

    def authorize(self, preflight=False):
        if self.headers.get_all("Host", []) != [f"{HOST}:{PORT}"]:
            raise RequestError(403, "HOST_DENIED", "只允许本机扩展访问。")
        origins = self.headers.get_all("Origin", [])
        if len(origins) > 1:
            raise RequestError(403, "ORIGIN_DENIED", "不支持此请求来源。")
        origin = origins[0] if origins else None
        if preflight:
            if not origin or not origin.startswith("chrome-extension://"):
                raise RequestError(403, "ORIGIN_DENIED", "不支持此请求来源。")
            extension_id = origin.removeprefix("chrome-extension://")
            if EXTENSION_ID.fullmatch(extension_id) is None:
                raise RequestError(403, "ORIGIN_DENIED", "不支持此请求来源。")
            methods = self.headers.get_all("Access-Control-Request-Method", [])
            if len(methods) != 1 or methods[0] not in {"GET", "POST"}:
                raise RequestError(403, "PREFLIGHT_DENIED", "不支持此预检请求。")
            requested = self.headers.get_all("Access-Control-Request-Headers", [])
            if len(requested) != 1:
                raise RequestError(403, "PREFLIGHT_DENIED", "扩展识别请求缺少必要请求头。")
            names = {name.strip().lower() for name in requested[0].split(",")}
            if "x-nol-extension-id" not in names or not names <= {"content-type", "x-nol-extension-id"}:
                raise RequestError(403, "PREFLIGHT_DENIED", "不支持此预检请求头。")
        else:
            ids = self.headers.get_all("X-NOL-Extension-Id", [])
            if len(ids) != 1 or EXTENSION_ID.fullmatch(ids[0]) is None:
                raise RequestError(403, "EXTENSION_ID_REQUIRED", "扩展识别请求缺少必要请求头。")
            if origin is not None and origin != f"chrome-extension://{ids[0]}":
                raise RequestError(403, "ORIGIN_DENIED", "不支持此请求来源。")
        self.allowed_origin = origin

    def reply(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")
        if getattr(self, "allowed_origin", None):
            self.send_header("Access-Control-Allow-Origin", self.allowed_origin)
            self.send_header("Vary", "Origin")
        if self.command == "OPTIONS" and status == 200:
            self.send_header("Access-Control-Allow-Methods", "GET, POST")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-NOL-Extension-Id")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def dispatch(self):
        try:
            self.authorize(preflight=self.command == "OPTIONS")
            if self.path not in {"/health", "/recognize"}:
                raise RequestError(404, "NOT_FOUND", "没有此本地接口。")
            if self.command == "OPTIONS":
                self.reply(200, {"ok": True})
            elif self.command == "GET" and self.path == "/health":
                self.reply(200, {"ok": True, "engine": "ddddocr", "version": "1.6.1", "serviceVersion": SERVICE_VERSION})
            elif self.command == "POST" and self.path == "/recognize":
                if self.headers.get_all("Transfer-Encoding", []):
                    raise RequestError(400, "INVALID_LENGTH", "不支持分块请求。")
                types = self.headers.get_all("Content-Type", [])
                if len(types) != 1 or types[0].split(";", 1)[0].strip().lower() != "application/json":
                    raise RequestError(415, "JSON_REQUIRED", "请求类型必须是 application/json。")
                lengths = self.headers.get_all("Content-Length", [])
                if len(lengths) != 1 or re.fullmatch(r"[0-9]+", lengths[0]) is None:
                    raise RequestError(400, "INVALID_LENGTH", "请求必须包含正确的内容长度。")
                if len(lengths[0]) > 6:
                    raise RequestError(413, "REQUEST_TOO_LARGE", "请求超过 512 KB。")
                length = int(lengths[0])
                if not 0 < length <= MAX_REQUEST_BYTES:
                    raise RequestError(413, "REQUEST_TOO_LARGE", "请求为空或超过 512 KB。")
                body = self.rfile.read(length)
                if len(body) != length:
                    raise RequestError(400, "INCOMPLETE_BODY", "请求未完整接收。")
                try:
                    payload = json.loads(body.decode("utf-8"))
                except (UnicodeError, json.JSONDecodeError, RecursionError):
                    raise RequestError(400, "INVALID_JSON", "请求 JSON 格式不正确。") from None
                image = validate_image(payload)
                self.reply(200, self.server.recognizer.recognize(image))
            else:
                raise RequestError(405, "METHOD_DENIED", "不支持此请求方法。")
        except RequestError as error:
            self.reply(error.status, {"ok": False, "recognized": False, "candidate": "", "code": error.code, "reason": error.reason})
        except (TimeoutError, OSError):
            # Client disconnected or incomplete request; do not log request data.
            self.close_connection = True

    do_GET = do_POST = do_OPTIONS = do_PUT = do_DELETE = do_HEAD = dispatch


class LocalOCRServer(ThreadingHTTPServer):
    def handle_error(self, _request, _client_address):
        # Do not emit tracebacks that could include request or model inputs.
        pass


def load_recognizer():
    import ddddocr

    engine = ddddocr.DdddOcr(show_ad=False, use_gpu=False)
    engine.set_ranges(LETTERS)
    # Warm the single CPU model with a generated blank image, never a saved CAPTCHA.
    output = io.BytesIO()
    Image.new("RGB", (200, 60), "white").save(output, format="PNG")
    engine.classification(output.getvalue(), png_fix=True)
    return Recognizer(engine)


def main():
    try:
        recognizer = load_recognizer()
        server = LocalOCRServer((HOST, PORT), Handler)
        server.recognizer = recognizer
    except Exception:
        print("本地 OCR 启动失败。请先运行 install.ps1 安装依赖，并检查 8765 端口是否被占用。", file=sys.stderr)
        return 1
    print(f"本地 OCR 已就绪：http://{HOST}:{PORT}；只接收扩展请求。按 Ctrl+C 停止。")
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
