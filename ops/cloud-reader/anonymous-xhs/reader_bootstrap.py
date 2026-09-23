"""Give the pinned upstream API fresh per-job state without changing the reader."""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import importlib
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile

READER_SHA256 = '070070a6b036c5d82259d304b46677a59981723b5929603eff8d273874211d0f'
BACKEND_COMMIT = '3261312721f0b37c705ba6515885bc7f34349f2f'


def prepare_upstream(reader: Path, state: Path):
    reader, state = reader.resolve(), state.resolve()
    if hashlib.sha256(reader.read_bytes()).hexdigest() != READER_SHA256:
        raise RuntimeError('reader_version_changed')
    repo = reader.parents[1] / 'repos' / 'downloaders' / 'XHS-Downloader'
    revision = subprocess.run(['git', '-C', str(repo), 'rev-parse', 'HEAD'],
                              capture_output=True, text=True, timeout=10)
    if revision.returncode or revision.stdout.strip() != BACKEND_COMMIT:
        raise RuntimeError('backend_version_changed')
    # Installation prepares this empty, root-owned directory. Its import-time
    # mkdir(exist_ok=True) then needs no write permission in the source checkout.
    volume = repo / 'Volume'
    if not volume.is_dir() or volume.is_symlink():
        raise RuntimeError('upstream_volume_not_prepared')
    if os.name == 'posix':
        info = volume.stat()
        if info.st_uid != 0 or info.st_mode & 0o222 or any(volume.iterdir()):
            raise RuntimeError('upstream_volume_not_immutable_empty')
    if any(name == 'source' or name.startswith('source.') for name in sys.modules):
        raise RuntimeError('upstream_already_imported')
    state.mkdir(mode=0o700, parents=False, exist_ok=False)
    os.environ['PYTHON_DOTENV_DISABLED'] = '1'
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(repo))
    source = importlib.import_module('source')
    app = importlib.import_module('source.application.app')
    module = importlib.import_module('source.module')
    static = importlib.import_module('source.module.static')
    if app.XHS is not source.XHS or any(item.VOLUME.resolve() != volume.resolve()
                                      for item in (app, module, static)):
        raise RuntimeError('upstream_state_contract_changed')
    # XHS.__init__ reads app.VOLUME when constructing Manager. Both database
    # recorders and Temp therefore live under this fresh job, even though the
    # upstream still opens its databases when record_data/download_record=False.
    for item in (app, module, static):
        item.VOLUME = state
    return source.XHS


def smoke_test(reader: Path, parent: Path):
    """Initialize/close real XHS and SQLite, with all HTTP requests denied."""
    from curl_cffi.requests import AsyncSession, Session
    import httpx

    attempted = []

    def deny(*args, **kwargs):
        attempted.append(True)
        raise RuntimeError('smoke_test_network_forbidden')

    async def deny_async(*args, **kwargs):
        deny()

    Session.request = deny
    AsyncSession.request = deny_async
    httpx.Client.request = deny
    httpx.AsyncClient.request = deny_async
    parent = parent.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix='init-smoke-', dir=parent) as directory:
        job = Path(directory).resolve()
        if job.parent != parent:
            raise RuntimeError('invalid_smoke_directory')
        work = job / 'work'
        work.mkdir()
        state = job / 'upstream-state'
        original_cwd = Path.cwd()
        try:
            os.chdir(job)
            XHS = prepare_upstream(reader, state)

            async def initialize():
                async with XHS(cookie='', proxy=None, max_retry=0, timeout=25,
                               work_path=str(work), folder_name='backend',
                               download_record=False, script_server=False,
                               note_format='', record_data=False) as xhs:
                    if xhs.manager.root != state or xhs.manager.temp != state / 'Temp':
                        raise RuntimeError('shared_upstream_state')
                    if list(xhs.manager.request_client.cookies.items()):
                        raise RuntimeError('smoke_test_cookie_present')
                    recorders = ((xhs.id_recorder, 'explore_id'),
                                 (xhs.map_recorder, 'mapping_data'),
                                 (xhs.data_recorder, 'explore_data'))
                    for recorder, table in recorders:
                        if not recorder.file.resolve().is_relative_to(job):
                            raise RuntimeError('shared_upstream_database')
                        cursor = await recorder.database.execute(f'SELECT COUNT(*) FROM {table}')
                        count = (await cursor.fetchone())[0]
                        await cursor.close()
                        if count != 0:
                            raise RuntimeError('nonempty_upstream_database')
                if attempted:
                    raise RuntimeError('smoke_test_network_attempted')

            asyncio.run(initialize())
        finally:
            os.chdir(original_cwd)
    print(json.dumps({'ok': True, 'check': 'real_upstream_initialization',
                      'networkRequests': 0, 'databases': 3, 'freshJobState': True}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reader', type=Path, required=True)
    parser.add_argument('--state-root', type=Path)
    parser.add_argument('--smoke-test', action='store_true')
    parser.add_argument('--smoke-parent', type=Path)
    parser.add_argument('reader_args', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    reader = args.reader.resolve()
    os.environ['PYTHON_DOTENV_DISABLED'] = '1'
    sys.dont_write_bytecode = True
    if args.smoke_test:
        if args.state_root or args.reader_args or not args.smoke_parent:
            parser.error('smoke test requires only --reader and --smoke-parent')
        smoke_test(reader, args.smoke_parent)
        return
    if not args.state_root:
        parser.error('--state-root is required')
    prepare_upstream(reader, args.state_root)
    sys.argv = [str(reader), *(args.reader_args[1:] if args.reader_args[:1] == ['--'] else args.reader_args)]
    runpy.run_path(str(reader), run_name='__main__')


if __name__ == '__main__':
    main()
