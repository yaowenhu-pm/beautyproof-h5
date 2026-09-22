"""Read one public XHS share page without account cookies; never evaluate page JS."""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse, parse_qs

from PIL import Image
import httpx

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0'
PAGE_HOSTS = {'www.xiaohongshu.com', 'xiaohongshu.com', 'xhslink.com', 'xhslink.cn'}
DENIED_PATHS = ('/login', '/website-login', '/404', '/captcha')
EXPECTED_BACKEND = '3261312721f0b37c705ba6515885bc7f34349f2f'

class ReadError(Exception):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)

async def get_page_with_xhs(url, trace, run):
    """Use the pinned upstream public reader, with TLS validation restored."""
    import certifi
    from curl_cffi.requests import AsyncSession
    repo = Path(__file__).resolve().parents[1]/'repos'/'downloaders'/'XHS-Downloader'
    revision = subprocess.run(['git','-C',str(repo),'rev-parse','HEAD'],capture_output=True,text=True,timeout=10)
    if revision.returncode or revision.stdout.strip()!=EXPECTED_BACKEND:
        raise ReadError('backend_version_changed','依赖版本与已验证版本不同，请先重新验收。')
    sys.path.insert(0, str(repo))
    from source import XHS
    ca_bytes = Path(certifi.where()).read_bytes()
    (run/'cacert.pem').write_bytes(ca_bytes)
    original = AsyncSession.request
    pages = []
    async def request(session, method, url, **kwargs):
        validate_url(str(url))
        if kwargs.get('cookies') or any(k.lower() in ('cookie','authorization') and v for k,v in kwargs.get('headers',{}).items()):
            raise ReadError('credential_rejected', '本工具仅允许匿名读取。')
        kwargs['verify'] = 'cacert.pem'
        kwargs['allow_redirects'] = False
        for _ in range(8):
            validate_url(str(url))
            response = await original(session, method, url, **kwargs)
            trace.append({'url':str(url),'resolved_url':str(response.url),'status':response.status_code,'bytes':len(response.content),'redirect_location':response.headers.get('location'),'checked_at':datetime.now(timezone.utc).isoformat()})
            if response.status_code in (301,302,303,307,308):
                location=response.headers.get('location')
                if not location: raise ReadError('bad_redirect','重定向缺少目标。')
                url=urljoin(str(url),location)
                validate_url(url)
                continue
            break
        else:
            raise ReadError('too_many_redirects','重定向次数超过上限。')
        validate_url(str(response.url))
        if response.status_code != 200:
            raise ReadError('http_error', f'平台返回 HTTP {response.status_code}。')
        pages.append((response.content, str(response.url)))
        return response
    old_cwd = Path.cwd()
    try:
        os.chdir(run)
        AsyncSession.request = request
        with (run/'backend.log').open('w',encoding='utf-8') as log, contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
            async with XHS(cookie='', proxy=None, max_retry=0, timeout=25, work_path=str(run), folder_name='backend',download_record=False,script_server=False,note_format='',record_data=False) as xhs:
                if list(xhs.manager.request_client.cookies.items()):
                    raise ReadError('credential_rejected', '会话不是空的匿名会话。')
                # Upstream extract resolves a short URL by downloading its target,
                # then fetches that target a second time. Keep the first response
                # from this request instead; validation below still requires the
                # exact target note and a complete gallery.
                await xhs.manager.request_client.request(
                    'GET', url, headers=xhs.manager.get_headers(url))
        if not pages:
            raise ReadError('no_response', '公开页读取失败，详见 backend.log。')
        return pages[-1]
    finally:
        AsyncSession.request = original
        os.chdir(old_cwd)

def get_image(url, trace):
    # Fresh client: no browser cookies, no account state, TLS verification on.
    if url.startswith('http://'):
        url='https://'+url[7:]
    with httpx.Client(timeout=30, trust_env=False, follow_redirects=False, headers={'Referer':'https://www.xiaohongshu.com/'}) as client:
        for _ in range(5):
            validate_url(url, media=True)
            with client.stream('GET',url) as response:
                trace.append({'url':url,'status':response.status_code,'kind':'image','checked_at':datetime.now(timezone.utc).isoformat()})
                if response.is_redirect:
                    url=urljoin(url,response.headers['location']); continue
                if response.status_code!=200:
                    raise ReadError('image_http_error',f'图片返回 HTTP {response.status_code}。')
                chunks=[];size=0
                for chunk in response.iter_bytes():
                    size+=len(chunk)
                    if size>30*1024*1024: raise ReadError('image_too_large','单张图片超过30MiB。')
                    chunks.append(chunk)
                return b''.join(chunks),url,response.headers.get('content-type','')
    raise ReadError('image_redirect_error','图片重定向次数过多。')

def input_url(text):
    match = re.search(r'https?://[^\s<>"`]+', text)
    if not match:
        raise ReadError('invalid_input', '需要完整分享链接；仅笔记ID不足以读取。')
    url = match.group().rstrip('，。；！？、【】《》）)')
    validate_url(url)
    return url

def validate_url(url, media=False):
    try:
        p = urlparse(url)
        port = p.port
    except ValueError as exc:
        raise ReadError('unsupported_url', '链接端口或格式无效。') from exc
    host = (p.hostname or '').lower()
    allowed = host in PAGE_HOSTS
    if media:
        allowed = allowed or any(host == d or host.endswith('.'+d) for d in ('xhscdn.com', 'xiaohongshu.com'))
    if p.scheme not in ('http', 'https') or p.username or p.password or port not in (None, 80, 443) or not allowed:
        raise ReadError('unsupported_url', '链接域名或格式不在支持范围内。')
    if any(p.path.startswith(part) for part in DENIED_PATHS):
        raise ReadError('unavailable_or_login', '平台返回登录、验证或不可浏览页面。')
    if parse_qs(p.query).get('undertake_note_error'):
        raise ReadError('note_unavailable', '平台明确返回该内容暂时无法查看。')

def parse_state(html):
    match = re.search(r'window\.__INITIAL_STATE__\s*=\s*', html)
    if not match:
        raise ReadError('no_note_state', '页面没有笔记数据；不把页面摘要当正文。')
    text = html[match.end():].lstrip()
    if not text.startswith('{'):
        raise ReadError('invalid_state', '笔记数据格式变化。')
    # Scan JSON-like data, replacing only unquoted undefined values; no eval/JS runtime.
    result, depth, quoted, escaped, i = [], 0, False, False, 0
    while i < len(text):
        char = text[i]
        if quoted:
            result.append(char)
            if escaped: escaped = False
            elif char == '\\': escaped = True
            elif char == '"': quoted = False
        elif char == '"':
            quoted = True; result.append(char)
        elif text.startswith('undefined', i):
            result.append('null'); i += 8
        else:
            result.append(char)
            if char in '{[': depth += 1
            elif char in '}]':
                depth -= 1
                if depth == 0: break
        i += 1
    try:
        return json.loads(''.join(result))
    except (ValueError, TypeError) as exc:
        raise ReadError('invalid_state', '无法安全解析笔记数据。') from exc

def extract_note(html, url):
    state = parse_state(html)
    match = re.search(r'/(?:explore|item)/([a-f0-9]{24})(?:[/?]|$)', urlparse(url).path + '/')
    if not match:
        raise ReadError('unknown_note_id', '页面地址中缺少笔记ID。')
    note_id = match.group(1)
    note = state.get('note', {}).get('noteDetailMap', {}).get(note_id, {}).get('note')
    if not isinstance(note, dict) or note.get('noteId') != note_id:
        raise ReadError('no_matching_note', '没有找到与链接ID一致的正文。')
    if note.get('type') not in ('normal', 'video'):
        raise ReadError('unsupported_note_type', '未知笔记类型。')
    if not isinstance(note.get('desc'), str) or not isinstance(note.get('imageList'), list):
        raise ReadError('incomplete_note', '正文或图片列表字段缺失。')
    if note['type']=='normal' and not note['imageList']:
        raise ReadError('incomplete_images', '图文笔记的图片列表为空。')
    images = []
    for index, img in enumerate(note['imageList'], 1):
        url = img.get('urlDefault') or next((v.get('url') for v in img.get('infoList', []) if v.get('imageScene') == 'WB_DFT'), None) or img.get('url')
        if not url:
            raise ReadError('incomplete_images', f'第 {index} 张图片缺少地址。')
        if url.startswith('//'): url = 'https:' + url
        images.append({'index': index, 'url': url, 'source_width': img.get('width'), 'source_height': img.get('height')})
    return {'note_id': note_id, 'title': note.get('title', ''), 'text': note['desc'], 'author': note.get('user', {}),
            'type': note['type'], 'published_at_ms': note.get('time'), 'updated_at_ms': note.get('lastUpdateTime'),
            'images': images, 'raw_note': note}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('link', help='分享链接或含链接的分享文案')
    parser.add_argument('--out', type=Path, default=Path(__file__).resolve().parent/'output')
    args = parser.parse_args()
    run = args.out.resolve()/datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    run.mkdir(parents=True)
    report = {'status':'started', 'input':args.link, 'checked_at':datetime.now(timezone.utc).isoformat(),
              'account_used':False, 'browser_cookies_read':False, 'cache_used':False, 'transport_mode':'single_page_fetch_v2', 'requests':[]}
    code = 1
    try:
        url = input_url(args.link)
        report['backend']='JoeanAmier/XHS-Downloader@3261312721f0b37c705ba6515885bc7f34349f2f'
        report['tls_verify']=True
        raw, final = asyncio.run(get_page_with_xhs(url, report['requests'], run))
        (run/'page.html').write_bytes(raw)
        note = extract_note(raw.decode('utf-8'), final)
        report.update(note)
        report['resolved_url'] = final
        (run/'raw-note.json').write_text(json.dumps(report.pop('raw_note'),ensure_ascii=False,indent=2),encoding='utf-8')
        (run/'images').mkdir()
        for item in note['images']:
            time.sleep(0.4)
            data, media_final, mime = get_image(item['url'], report['requests'])
            with Image.open(io.BytesIO(data)) as im:
                width, height, fmt = im.width, im.height, im.format
                frames = getattr(im, 'n_frames', 1)
                for frame in range(frames):
                    im.seek(frame)
                    im.load()
            suffix = {'JPEG':'jpg','PNG':'png','WEBP':'webp','GIF':'gif','AVIF':'avif'}.get(fmt, fmt.lower())
            file = run/'images'/f'{item["index"]:02d}.{suffix}'
            file.write_bytes(data)
            item.update(file=str(file.relative_to(run)),sha256=hashlib.sha256(data).hexdigest(),bytes=len(data),width=width,height=height,format=fmt,frames=frames,mime=mime)
        report['text_sha256'] = hashlib.sha256(note['text'].encode()).hexdigest()
        report['status'] = 'ok'
        report['images_downloaded'] = len(note['images'])
        report['images_role'] = ('video_cover' if len(note['images'])==1 else 'video_note_image_list') if note['type']=='video' else 'note_images'
        markdown = '# '+(note['title'] or '(无标题)')+'\n\n'+note['text']+'\n\n'+''.join(f'![图片 {im["index"]}]({im["file"]})\n\n' for im in note['images'])
        markdown += f'来源：{final}\n\n读取时间：{report["checked_at"]}\n'
        (run/'note.md').write_text(markdown,encoding='utf-8')
        code = 0
    except ReadError as exc:
        report.update(status=exc.status,error=str(exc))
    except Exception as exc:
        report.update(status='validation_or_runtime_error',error=f'{type(exc).__name__}: {exc}')
    (run/'result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'status':report['status'],'title':report.get('title'),'images_downloaded':report.get('images_downloaded',0),'directory':str(run),'error':report.get('error')},ensure_ascii=False))
    return code

if __name__ == '__main__':
    sys.exit(main())
