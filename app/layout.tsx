import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  manifest: '/manifest.webmanifest',
  title: '真妍盾｜美妆内容可信吗？',
  description: '提交美妆链接、图片、视频或文字，对照成分研究与宣传依据，让判断回到证据。',
  openGraph: {
    type: 'website',
    locale: 'zh_CN',
    title: '真妍盾｜这条美妆内容可信吗？',
    description: '看清成分，也看清宣传。对照原文、成分研究与宣传依据。',
    images: [{ url: '/og.png', width: 1731, height: 909, alt: '真妍盾 BeautyProof 社交分享卡片' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: '真妍盾｜这条美妆内容可信吗？',
    description: '看清成分，也看清宣传。对照原文、成分研究与宣传依据。',
    images: ['/og.png'],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body></html>;
}
