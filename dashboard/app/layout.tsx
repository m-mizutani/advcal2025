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
  },
  twitter: {
    card: "summary_large_image",
    title: "advcal2025",
    description: "セキュリティ分析LLMエージェント実装 - 2025年アドベントカレンダー",
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
