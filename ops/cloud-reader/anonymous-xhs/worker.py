"""One anonymous child read followed by a separate offline evidence audit."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlsplit

from compare_runs import audit_run

READER_SHA256 = '070070a6b036c5d82259d304b46677a59981723b5929603eff8d273874211d0f'


def public_media_url(value):
    value = 'https:' + value[5:] if value.startswith('http:') else value
    parsed = urlsplit(value)
    host = (parsed.hostname or '').lower()
    if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.port not in (None, 443) or not any(host == domain or host.endswith('.' + domain) for domain in ('xhscdn.com', 'xiaohongshu.com')):
        raise ValueError('unsupported_media_url')
    return value


def page_redirects(requests):
    redirects = []
    for item in requests:
        if item.get('kind') == 'image' or not isinstance(item.get('url'), str):
            continue
        parsed = urlsplit(item['url'])
        redirects.append({'host': parsed.hostname, 'path': parsed.path, 'status': item.get('status', 0)})
    return redirects


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--reader', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    payload = json.load(sys.stdin)
    args.out.mkdir(parents=True, exist_ok=False)
    if hashlib.sha256(args.reader.read_bytes()).hexdigest() != READER_SHA256:
        raise RuntimeError('reader_version_changed')
    env = {k: v for k, v in os.environ.items() if k in ('PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'LANG')}
    env.update(PYTHONIOENCODING='utf-8', PYTHONUNBUFFERED='1', PYTHON_DOTENV_DISABLED='1')
    # No browser profile, credential environment, inherited proxy, or old result input.
    with (args.out / 'child.log').open('wb') as log:
        child = subprocess.run([sys.executable, str(Path(__file__).resolve().with_name('reader_bootstrap.py')),
                                '--reader', str(args.reader.resolve()),
                                '--state-root', str(args.out.resolve() / 'upstream-state'),
                                '--', payload['url'], '--out', str(args.out.resolve())],
                               stdout=log, stderr=subprocess.STDOUT, env=env,
                               cwd=str(args.out.resolve()), timeout=285)
    candidates = list(args.out.glob('*/result.json'))
    if len(candidates) != 1:
        raise RuntimeError('missing_result')
    result_path = candidates[0]
    raw = json.loads(result_path.read_text(encoding='utf-8'))
    audit = audit_run(result_path, exit_code=child.returncode)
    (args.out / 'audit.json').write_text(json.dumps(audit, ensure_ascii=False, indent=2), encoding='utf-8')
    if child.returncode or raw.get('status') != 'ok' or not audit.get('actual_success') or not raw.get('text', '').strip():
        output = {'ok': False, 'error': raw.get('status', 'audit_failed'), 'auditPassed': False}
    else:
        output = {'ok': True, 'auditPassed': True, 'evidenceDirectory': str(result_path.parent.resolve()),
                  'result': {'noteId': raw['note_id'], 'title': raw.get('title', ''), 'text': raw['text'],
                             'textSha256': raw['text_sha256'], 'canonicalUrl': raw['resolved_url'],
                             'type': raw['type'], 'imagesRole': raw['images_role'], 'mediaStatus': 'complete',
                             'sourceImageCount': len(raw['images']), 'checkedAt': raw['checked_at'],
                             'accountUsed': False, 'browserCookiesRead': False, 'cacheUsed': False,
                             'readerSha256': READER_SHA256,
                             'redirects': page_redirects(raw.get('requests', [])),
                             'images': [{**{k: image[k] for k in ('index', 'sha256', 'bytes', 'width', 'height', 'format', 'frames')},
                                         'file': image['file'].replace('\\', '/'), 'url': public_media_url(image['url'])}
                                        for image in raw['images']]}}
    (args.out / 'validated.json').write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(output, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except subprocess.TimeoutExpired:
        print(json.dumps({'ok': False, 'error': 'timeout'}))
        sys.exit(1)
    except Exception as exc:
        # Do not echo a URL, credential, third-party response, or local path in API errors.
        print(json.dumps({'ok': False, 'error': 'worker_failed', 'errorType': type(exc).__name__}))
        sys.exit(1)
