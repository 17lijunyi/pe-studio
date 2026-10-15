import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PE Studio · 提示词专家",
  description: "让随手的想法，成为更好的提示词。四个方向、三个模型、Jev 评审。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
