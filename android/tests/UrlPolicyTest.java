package com.beautyproof.trial;

public final class UrlPolicyTest {
    private static int count = 0;
    private static void check(boolean value, String label) {
        if (!value) throw new AssertionError(label);
        count++;
    }
    public static void main(String[] args) {
        check(UrlPolicy.isInternal(UrlPolicy.HOME), "home");
        check(UrlPolicy.isInternal(UrlPolicy.HOME + "?source=android#report"), "same origin navigation");
        check(UrlPolicy.isInternal("https://beautyproof-h5.yaowen-hu.chatgpt.site:443/"), "default TLS port");
        for (String value : new String[]{
            "http://beautyproof-h5.yaowen-hu.chatgpt.site/", "https://beautyproof-h5.yaowen-hu.chatgpt.site.evil.test/",
            "https://beautyproof-h5.yaowen-hu.chatgpt.site@evil.test/", "https://user@beautyproof-h5.yaowen-hu.chatgpt.site/",
            "https://beautyproof-h5.yaowen-hu.chatgpt.site:8443/", "https://evil.test/?beautyproof-h5.yaowen-hu.chatgpt.site",
            "javascript:alert(1)", "file:///sdcard/private.txt", "content://private.provider/1", "intent://anything",
            "https://127.0.0.1/", "https://[::1]/", "data:text/html,<script>alert(1)</script>", "about:blank", "", null}) {
            check(!UrlPolicy.isInternal(value), "reject internal spoof: " + value);
        }
        check(UrlPolicy.isEvidenceLink("https://pubmed.ncbi.nlm.nih.gov/16029679/"), "PubMed evidence");
        check(UrlPolicy.isEvidenceLink("https://www.nmpa.gov.cn/example"), "official regulator");
        check(UrlPolicy.isEvidenceLink("https://eur-lex.europa.eu/eli/dec_impl/2025/1175/oj/eng"), "EU evidence");
        for (String value : new String[]{"https://evilgov.cn/", "https://pubmed.ncbi.nlm.nih.gov.evil.test/", "http://www.nmpa.gov.cn/", "https://user@www.nmpa.gov.cn/", "https://www.nmpa.gov.cn:444/"}) {
            check(!UrlPolicy.isEvidenceLink(value), "reject evidence spoof: " + value);
        }
        System.out.println(count + " pure-Java URL policy assertions passed. No Android SDK or device execution.");
    }
}
