package com.beautyproof.trial;

import java.net.URI;
import java.util.Locale;

/** Independent of Android so the navigation policy can be tested without an SDK. */
public final class UrlPolicy {
    public static final String HOME = "https://beautyproof-h5.yaowen-hu.chatgpt.site/";
    private static final String HOST = "beautyproof-h5.yaowen-hu.chatgpt.site";
    private UrlPolicy() {}

    private static URI parseHttps(String value) {
        try {
            URI uri = new URI(value);
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null
                    || uri.getRawUserInfo() != null || (uri.getPort() != -1 && uri.getPort() != 443)) return null;
            return uri;
        } catch (Exception ignored) { return null; }
    }

    public static boolean isInternal(String value) {
        URI uri = parseHttps(value);
        return uri != null && HOST.equalsIgnoreCase(uri.getHost());
    }

    public static boolean isEvidenceLink(String value) {
        URI uri = parseHttps(value);
        if (uri == null) return false;
        String host = uri.getHost().toLowerCase(Locale.ROOT);
        return host.equals("pubmed.ncbi.nlm.nih.gov") || host.equals("pmc.ncbi.nlm.nih.gov")
                || host.equals("doi.org") || host.equals("eur-lex.europa.eu")
                || host.equals("single-market-economy.ec.europa.eu")
                || host.equals("www.fda.gov") || host.endsWith(".gov.cn");
    }
}
