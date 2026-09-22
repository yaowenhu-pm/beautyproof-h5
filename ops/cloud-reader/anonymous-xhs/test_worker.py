import unittest
from worker import public_media_url, page_redirects


class MetadataBoundaryTests(unittest.TestCase):
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
