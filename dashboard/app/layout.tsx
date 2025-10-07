import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "advcal2025",
  description: "セキュリティ分析LLMエージェント実装 - 2025年アドベントカレンダー",
  openGraph: {
    title: "advcal2025",
    description: "セキュリティ分析LLMエージェント実装 - 2025年アドベントカレンダー",
    url: "https://m-mizutani.github.io/advcal2025/",
    siteName: "advcal2025",
    locale: "ja_JP",
    type: "website",
    images: [
      {
        url: "https://m-mizutani.github.io/advcal2025/ogp.png",
        width: 1200,
        height: 630,
        alt: "advcal2025 - セキュリティ分析LLMエージェント実装",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "advcal2025",
    description: "セキュリティ分析LLMエージェント実装 - 2025年アドベントカレンダー",
    images: ["https://m-mizutani.github.io/advcal2025/ogp.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
