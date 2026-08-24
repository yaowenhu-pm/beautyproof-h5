import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: '真妍盾工作台｜美妆内容鉴真',
  description: '提交作品链接、媒体文件或文字，查看来源、媒体与宣称证据。',
  openGraph: {
    type: 'website',
    locale: 'zh_CN',
    title: '真妍盾 BeautyProof｜让每一份真实，都有证据',
    description: '粘贴小红书、抖音链接，或上传图文视频，生成可解释的美妆内容鉴真报告。',
    images: [{ url: '/og.png', width: 1731, height: 909, alt: '真妍盾 BeautyProof 社交分享卡片' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: '真妍盾 BeautyProof｜让每一份真实，都有证据',
    description: '从来源、篡改、宣称与合规四个维度，生成可解释的证据报告。',
    images: ['/og.png'],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body></html>;
}
