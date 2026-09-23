import unittest
from contextlib import redirect_stdout
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch
import worker
from worker import public_media_url, page_redirects


class MetadataBoundaryTests(unittest.TestCase):
    def test_child_uses_fresh_state_bootstrap_without_credential_environment(self):
        with tempfile.TemporaryDirectory(prefix='beautyproof-worker-test-') as temporary:
            root = Path(temporary).resolve()
            reader = root / 'reader.py'
            reader.write_text('# fixed fixture', encoding='utf-8')
            output = root / 'fresh-job'
            calls = []

            def child(command, **kwargs):
                calls.append((command, kwargs))
                evidence = output / 'timestamp'
                evidence.mkdir()
                (evidence / 'result.json').write_text(json.dumps({'status': 'note_unavailable'}), encoding='utf-8')
                return subprocess.CompletedProcess(command, 1)

            with patch.object(sys, 'argv', ['worker.py', '--reader', str(reader), '--out', str(output)]), \
                 patch.object(sys, 'stdin', io.StringIO(json.dumps({'url': 'https://xhslink.cn/o/fixture'}))), \
                 patch.dict(os.environ, {'READER_PRIVATE_KEY': 'test-secret', 'HTTPS_PROXY': 'test-proxy'}), \
                 patch.object(worker, 'READER_SHA256', hashlib.sha256(reader.read_bytes()).hexdigest()), \
                 patch.object(worker.subprocess, 'run', side_effect=child), \
                 patch.object(worker, 'audit_run', return_value={'actual_success': False}), \
                 redirect_stdout(io.StringIO()):
                self.assertEqual(worker.main(), 0)
            self.assertEqual(len(calls), 1)
            command, options = calls[0]
            self.assertEqual(Path(command[1]).name, 'reader_bootstrap.py')
            self.assertEqual(command[command.index('--state-root') + 1], str(output / 'upstream-state'))
            self.assertEqual(options['cwd'], str(output))
            self.assertEqual(options['env']['PYTHON_DOTENV_DISABLED'], '1')
            self.assertNotIn('READER_PRIVATE_KEY', options['env'])
            self.assertNotIn('HTTPS_PROXY', options['env'])
            self.assertFalse(json.loads((output / 'validated.json').read_text(encoding='utf-8'))['ok'])

    def test_media_url_preserves_required_query_and_requires_public_cdn(self):
        self.assertEqual(public_media_url('http://sns-webpic-qc.xhscdn.com/image?sign=example'),
                         'https://sns-webpic-qc.xhscdn.com/image?sign=example')
        for value in ('https://127.0.0.1/a', 'https://xhscdn.com.evil.test/a', 'https://u:p@xhscdn.com/a',
                      'file:///etc/passwd', 'https://xhscdn.com:18080/a', 'https://xhslink.cn/o/a'):
            with self.assertRaises(ValueError):
                public_media_url(value)

    def test_redirect_identity_has_first_share_and_final_note_not_media(self):
        values = [{'url': 'https://xhslink.cn/o/abc?tracking=hidden', 'status': 302},
                  {'url': 'https://www.xiaohongshu.com/explore/' + 'a' * 24 + '?xsec_token=hidden', 'status': 200},
                  {'url': 'https://cdn.xhscdn.com/image', 'status': 200, 'kind': 'image'}]
        self.assertEqual(page_redirects(values), [
            {'host': 'xhslink.cn', 'path': '/o/abc', 'status': 302},
            {'host': 'www.xiaohongshu.com', 'path': '/explore/' + 'a' * 24, 'status': 200}])


if __name__ == '__main__':
    unittest.main()
