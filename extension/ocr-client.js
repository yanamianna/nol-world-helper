(function(root) {
  'use strict';
  const origin = 'http://127.0.0.1/*';
  const endpoint = 'http://127.0.0.1:8765';
  const imagePattern = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
  const safeErrors=new WeakSet();
  function fail(code, message) { const error=new Error(message); error.code=code;safeErrors.add(error);throw error; }
  function imageBody(value) {
    const match=typeof value==='string' && value.length<=500000 && imagePattern.exec(value);
    if(!match || match[1].length%4!==0) fail('OCR_IMAGE_INVALID','验证码图片格式无法识别，请手动输入。');
    return {image:match[1]};
  }
  function create(api, fetcher) {
    let busy=false;
    const enabled=async()=>{try{return await api.permissions.contains({origins:[origin]});}catch{fail('OCR_UNAVAILABLE','本机识别权限检查失败，请重新加载扩展。');}};
    async function request(path, body) {
      if(!await enabled()) fail('OCR_PERMISSION_REQUIRED','请先在扩展弹窗启用本机识别。');
      if(busy) fail('OCR_BUSY','正在识别，请等待当前结果。');
      busy=true;
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
      try {
        const response=await fetcher(endpoint+path,{method:body?'POST':'GET',credentials:'omit',redirect:'error',cache:'no-store',signal:controller.signal,headers:{'X-NOL-Extension-Id':api.runtime.id,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
        if(!response.ok) fail('OCR_SERVICE_ERROR','本机识别服务未就绪或拒绝请求，请检查启动窗口。');
        const text=await response.text();
        if(text.length>4096) fail('OCR_RESPONSE_INVALID','本机识别服务返回异常，请手动输入。');
        let data; try {data=JSON.parse(text);} catch {fail('OCR_RESPONSE_INVALID','本机识别服务返回异常，请手动输入。');}
        if(data?.ok!==true) fail('OCR_RESPONSE_INVALID','本机识别服务返回异常，请手动输入。');
        if(path==='/health') {
          if(data.engine!=='ddddocr') fail('OCR_RESPONSE_INVALID','当前端口不是预期的 ddddocr 服务。');
          return {ready:true,engine:'ddddocr'};
        }
        if(data.recognized!==true || typeof data.candidate!=='string' || !/^[A-Z]{6}$/.test(data.candidate)) return {recognized:false,candidate:'',reason:'未识别出有效的6位字母，请手动输入或更换图片后重试。'};
        return {recognized:true,candidate:data.candidate,reason:'这是识别候选，请对照图片核对后填入。'};
      } catch(error) {
        if(safeErrors.has(error)) throw error;
        fail('OCR_UNAVAILABLE','无法连接本机识别服务，请先运行 local-ocr 中的启动脚本。');
      } finally {clearTimeout(timer);busy=false;}
    }
    return Object.freeze({enabled,health:()=>request('/health'),recognize:value=>request('/recognize',imageBody(value))});
  }
  const H=root.NolHelper=root.NolHelper||{};
  H.localOCR=Object.freeze({origin,create,imageBody});
}(globalThis));
