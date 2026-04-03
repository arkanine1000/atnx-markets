import type { Metadata } from "next";
import { DemoProvider } from "@/context/DemoContext";
import "./globals.css";

export const metadata: Metadata = {
  title: "ATNX — Attention Exchange",
  description: "Capture, identify, and track trending content with AI",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col font-mono">
        <DemoProvider>{children}</DemoProvider>
      </body>
    </html>
  );
}
