"""Offline audit of reader evidence. No network, user configuration, or reader imports.

API:
  audit_run(result_path_or_directory, *, exit_code=None, expected_note_id=None)
  compare_runs(baseline_path_or_audit, current_path_or_audit, **audit_kwargs)
  summarize(baseline_paths, current_paths, *, exit_codes=None, expected_note_ids=None)
Paths may be a result.json, run directory, output root, or list thereof.
Mapping keys for exit_codes / expected_note_ids are absolute result.json paths
or absolute run-directory paths. Unknown exit codes are never inferred as zero.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
from typing import Mapping
from urllib.parse import urlsplit, unquote

from PIL import Image, ImageFile


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def note_id_from_url(value):
    match = re.search(r'/(?:explore|item)/([a-fA-F0-9]{24})(?=[/?#\s]|$)', value or '')
    return match.group(1).lower() if match else None


def source_identity(item):
    """Prefer original fileId; strip only recognized XHS CDN signing wrappers.

    Unknown hosts retain their full URL. Unknown paths are not guessed by basename.
    Equal identity means same source reference, not necessarily equal image pixels.
    """
    file_id = item.get('fileId')
    if isinstance(file_id, str) and file_id.strip():
        return 'asset:' + file_id.strip().lstrip('/').split('!', 1)[0]
    url = item.get('urlDefault') or item.get('url')
    if not url:
        url = next((x.get('url') for x in item.get('infoList', [])
                    if x.get('imageScene') == 'WB_DFT'), None)
    if not isinstance(url, str) or not url:
        return None
    parts = urlsplit('https:' + url if url.startswith('//') else url)
    host = (parts.hostname or '').lower()
    if host == 'xhscdn.com' or host.endswith('.xhscdn.com'):
        path = unquote(parts.path).lstrip('/')
        path = re.sub(r'^\d{8,14}/[a-fA-F0-9]{16,64}/', '', path)
        return 'asset:' + path.split('!', 1)[0]
    return 'url:' + url


def page_note(path, note_id):
    html = path.read_text(encoding='utf-8')
    found = re.search(r'window\.__INITIAL_STATE__\s*=\s*', html)
    if not found:
        raise ValueError('no INITIAL_STATE marker in saved page')
    tail = html[found.end():].lstrip()
    # Lex strings atomically, so literal "undefined" is never changed. No JS eval.
    tail = re.sub(r'"(?:\\.|[^"\\])*"|\bundefined\b',
                  lambda m: 'null' if m.group() == 'undefined' else m.group(), tail)
    state, _ = json.JSONDecoder().raw_decode(tail)
    return state['note']['noteDetailMap'][note_id]['note']


def decode_image(path):
    data = path.read_bytes()
    # verify() checks the container where implemented; reopen and load every frame.
    old = ImageFile.LOAD_TRUNCATED_IMAGES
    ImageFile.LOAD_TRUNCATED_IMAGES = False
    try:
        with Image.open(path) as image:
            image.verify()
        pixels = hashlib.sha256()
        with Image.open(path) as image:
            width, height, fmt = image.width, image.height, image.format
            frames = getattr(image, 'n_frames', 1)
            for n in range(frames):
                image.seek(n)
                image.load()
                frame = image.convert('RGBA')
                pixels.update(json.dumps([n, *frame.size], separators=(',', ':')).encode())
                pixels.update(frame.tobytes())
        return {'sha256': sha256(data), 'bytes': len(data), 'width': width,
                'height': height, 'format': fmt, 'frames': frames,
                'pixel_sha256': pixels.hexdigest(), 'decode_ok': True}
    finally:
        ImageFile.LOAD_TRUNCATED_IMAGES = old


def _result_path(path):
    path = Path(path).resolve()
    return path / 'result.json' if path.is_dir() else path


def audit_run(result_path, *, exit_code=None, expected_note_id=None):
    path = _result_path(result_path)
    root = path.parent
    out = {'result_path': str(path), 'directory': str(root), 'exit_code': exit_code,
           'exit_code_verified': exit_code is not None, 'issues': [], 'warnings': [],
           'images': [], 'actual_success': False, 'content_integrity_ok': False}
    issues = out['issues']
    if expected_note_id and not re.fullmatch(r'[a-fA-F0-9]{24}', str(expected_note_id)):
        out['warnings'].append('invalid_expected_note_id_ignored')
        expected_note_id = None
    if expected_note_id:
        expected_note_id = expected_note_id.lower()
    out['expected_note_id'] = expected_note_id

    def issue(code, **detail):
        issues.append({'code': code, **detail})

    try:
        report = json.loads(path.read_text(encoding='utf-8-sig'))
        if not isinstance(report, dict):
            raise ValueError('result is not an object')
    except Exception as error:
        issue('result_unreadable', detail=f'{type(error).__name__}: {error}')
        out['classification'] = 'missing_or_invalid_result'
        return out
    out.update(status=report.get('status'), checked_at=report.get('checked_at'),
               note_id=report.get('note_id') or note_id_from_url(report.get('resolved_url'))
               or note_id_from_url(report.get('input')), title=report.get('title'),
               type=report.get('type'), reader_error=report.get('error'),
               published_at_ms=report.get('published_at_ms'),
               updated_at_ms=report.get('updated_at_ms'))
    claimed_ok = report.get('status') == 'ok'
    if exit_code is None:
        out['warnings'].append('process_exit_code_not_recorded')
    elif (exit_code == 0) != claimed_ok:
        issue('exit_status_mismatch', status=report.get('status'), exit_code=exit_code)
    for key in ('account_used', 'browser_cookies_read', 'cache_used'):
        if report.get(key) is not False:
            issue('anonymity_or_freshness_flag_not_false', field=key)
    if report.get('tls_verify') is not True:
        issue('tls_not_verified')
    if not claimed_ok:
        issue('reader_reported_failure', status=report.get('status'))
    note_id = out['note_id']
    if not isinstance(note_id, str) or not re.fullmatch(r'[a-f0-9]{24}', note_id):
        issue('invalid_note_id')
    for label, expected in [('expected', expected_note_id),
                            ('resolved_url', note_id_from_url(report.get('resolved_url'))),
                            ('input_url', note_id_from_url(report.get('input')))]:
        if expected and note_id != expected:
            issue('note_id_mismatch', source=label, expected=expected, actual=note_id)
    raw = None
    try:
        raw = json.loads((root / 'raw-note.json').read_text(encoding='utf-8-sig'))
        if not isinstance(raw, dict):
            raise ValueError('raw note is not an object')
        if raw.get('noteId') != note_id:
            issue('raw_note_id_mismatch')
        original = page_note(root / 'page.html', note_id)
        if raw != original:
            issue('raw_note_differs_from_saved_page')
    except Exception as error:
        issue('source_evidence_missing_or_invalid', detail=f'{type(error).__name__}: {error}')
    text = report.get('text')
    if not isinstance(text, str):
        issue('text_missing')
    else:
        out['text_sha256'] = sha256(text.encode('utf-8'))
        out['text_length'] = len(text)
        if out['text_sha256'] != report.get('text_sha256'):
            issue('text_hash_mismatch')
    if raw:
        for report_key, source_key in [('text', 'desc'), ('title', 'title'), ('type', 'type')]:
            if report.get(report_key) != raw.get(source_key, '' if source_key == 'title' else None):
                issue('extracted_field_differs_from_source', field=report_key)
    images = report.get('images', [])
    raw_images = raw.get('imageList', []) if raw else []
    if not isinstance(images, list) or not isinstance(raw_images, list):
        issue('invalid_image_list')
        images, raw_images = [], []
    out['image_count'] = len(images)
    out['source_image_count'] = len(raw_images)
    if len(images) != len(raw_images):
        issue('image_count_mismatch', reported=len(images), source=len(raw_images))
    if claimed_ok and report.get('images_downloaded') != len(images):
        issue('images_downloaded_count_mismatch')
    if not images:
        issue('no_images_saved')
    seen_files = set()
    for n, item in enumerate(images, 1):
        inspected = {'index': n, 'decode_ok': False}
        out['images'].append(inspected)
        if not isinstance(item, dict):
            issue('invalid_image_entry', index=n)
            continue
        if item.get('index') != n:
            issue('image_order_index_mismatch', index=n)
        source = raw_images[n-1] if n <= len(raw_images) and isinstance(raw_images[n-1], dict) else {}
        inspected['source_identity'] = source_identity(source)
        inspected['url_identity'] = source_identity(item)
        if not inspected['source_identity'] or inspected['source_identity'] != inspected['url_identity']:
            issue('image_source_or_order_mismatch', index=n)
        try:
            relative = item.get('file')
            if not isinstance(relative, str) or not relative:
                raise ValueError('image file path missing')
            file = (root / relative.replace('\\', '/')).resolve()
            if not file.is_relative_to(root) or file in seen_files:
                raise ValueError('image file outside run or reused for another slot')
            seen_files.add(file)
            inspected['file'] = str(file)
            inspected.update(decode_image(file))
            for key in ('sha256', 'bytes', 'width', 'height', 'format'):
                if inspected[key] != item.get(key):
                    issue('image_metadata_mismatch', index=n, field=key,
                          reported=item.get(key), actual=inspected[key])
        except Exception as error:
            issue('image_missing_or_decode_failed', index=n, detail=f'{type(error).__name__}: {error}')
    out['images_fully_decoded'] = sum(i['decode_ok'] for i in out['images'])
    out['source_image_identities'] = [i.get('source_identity') for i in out['images']]
    out['content_integrity_ok'] = not issues
    out['actual_success'] = claimed_ok and not issues and exit_code in (None, 0)
    out['partial_download'] = 0 < out['images_fully_decoded'] < max(len(images), len(raw_images))
    out['classification'] = ('verified_success' if out['actual_success'] else
                             'success_claim_failed_audit' if claimed_ok else 'reader_failed')
    return out


def compare_runs(baseline, current, *, exit_code=None, expected_note_id=None):
    base = baseline if isinstance(baseline, Mapping) else audit_run(baseline)
    now = current if isinstance(current, Mapping) else audit_run(
        current, exit_code=exit_code, expected_note_id=expected_note_id)
    out = {'baseline': base, 'current': now, 'changes': [], 'classification': None}
    if not now['actual_success']:
        out['classification'] = now['classification']
        return out
    if not base['actual_success']:
        out['classification'] = 'baseline_failed_audit'
        return out
    if base['note_id'] != now['note_id']:
        out['classification'] = 'different_note_id'
        return out
    changes = out['changes']
    for field, label in [('text_sha256', 'source_text_changed'), ('title', 'source_title_changed'),
                         ('type', 'source_type_changed')]:
        if base.get(field) != now.get(field):
            changes.append(label)
    old_ids, new_ids = base['source_image_identities'], now['source_image_identities']
    if old_ids != new_ids:
        changes.append('source_image_order_changed' if Counter(old_ids) == Counter(new_ids)
                       else 'source_image_list_changed')
    out['image_deltas'] = []
    for n, (old, new) in enumerate(zip(base['images'], now['images']), 1):
        if old.get('source_identity') != new.get('source_identity'):
            kind = 'different_source_reference'
        elif old['sha256'] == new['sha256']:
            kind = 'same_bytes'
        elif old['pixel_sha256'] == new['pixel_sha256']:
            kind = 'same_pixels_different_encoding'
        else:
            kind = 'same_source_reference_different_pixels'
        out['image_deltas'].append({'index': n, 'classification': kind})
    kinds = {x['classification'] for x in out['image_deltas']}
    if 'same_source_reference_different_pixels' in kinds:
        changes.append('image_content_changed_same_source_reference')
    if 'same_pixels_different_encoding' in kinds:
        changes.append('image_encoding_changed_same_pixels')
    if any(x.startswith('source_') for x in changes):
        out['classification'] = 'verified_success_source_changed'
    elif 'image_content_changed_same_source_reference' in changes:
        out['classification'] = 'verified_success_media_changed_needs_review'
    elif changes:
        out['classification'] = 'verified_success_same_content_reencoded'
    else:
        out['classification'] = 'verified_success_identical_content'
    return out


def discover_results(paths):
    if isinstance(paths, (str, Path)):
        paths = [paths]
    found = set()
    for value in paths:
        path = Path(value).resolve()
        if path.is_dir():
            if (path / 'result.json').is_file():
                found.add(path / 'result.json')
            else:
                found.update(path.rglob('result.json'))
        else:
            found.add(path)
    return sorted(found)


def summarize(baseline_paths, current_paths, *, exit_codes=None, expected_note_ids=None):
    def mapped(mapping, path):
        if not mapping:
            return None
        return mapping.get(str(path), mapping.get(str(path.parent)))
    baselines = [audit_run(p) for p in discover_results(baseline_paths)]
    by_id = {}
    for value in sorted(baselines, key=lambda x: x.get('checked_at') or ''):
        if value['actual_success']:
            by_id[value['note_id']] = value
    currents, comparisons = [], []
    for path in discover_results(current_paths):
        current = audit_run(path, exit_code=mapped(exit_codes, path),
                            expected_note_id=mapped(expected_note_ids, path))
        currents.append(current)
        baseline = by_id.get(current.get('note_id') or current.get('expected_note_id'))
        if baseline:
            comparisons.append(compare_runs(baseline, current))
        else:
            comparisons.append({'baseline': None, 'current': current, 'changes': [],
                                'classification': 'verified_success_new_sample' if current['actual_success']
                                else current['classification']})
    unique = {r['note_id'] for r in currents if r['actual_success']}
    return {'schema_version': 1, 'baseline_runs': len(baselines),
            'baseline_verified_runs': sum(r['actual_success'] for r in baselines),
            'current_runs': len(currents), 'verified_successes': sum(r['actual_success'] for r in currents),
            'unique_successful_notes': len(unique),
            'exit_codes_recorded': sum(r['exit_code_verified'] for r in currents),
            'classification_counts': dict(Counter(r['classification'] for r in comparisons)),
            'baseline_audits': baselines, 'comparisons': comparisons,
            'limitations': ['Offline artifact checks do not independently prove network freshness or anonymity.',
                           'Source changes are observed in saved page evidence, not proof of an author edit.',
                           'Retries of one note are repeated runs, not independent sample notes.',
                           'Image identity normalization ignores recognized CDN timestamp/signature changes.']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', nargs='+', required=True)
    parser.add_argument('--current', nargs='+', required=True)
    parser.add_argument('--exit-codes', type=Path, help='JSON mapping of absolute result/directory paths to exit codes')
    parser.add_argument('--expected-note-ids', type=Path)
    parser.add_argument('--out', type=Path)
    args = parser.parse_args()
    load = lambda p: json.loads(p.read_text(encoding='utf-8-sig')) if p else None
    result = summarize(args.baseline, args.current, exit_codes=load(args.exit_codes),
                       expected_note_ids=load(args.expected_note_ids))
    content = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        args.out.write_text(content + '\n', encoding='utf-8')
    else:
        print(content)
    return 0 if result['current_runs'] and result['verified_successes'] == result['current_runs'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
