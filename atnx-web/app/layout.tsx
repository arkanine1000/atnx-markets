import type { Metadata, Viewport } from "next";
import { ThemeProvider } from "next-themes";
import { AuthProvider } from "@/context/AuthContext";
import { DemoProvider } from "@/context/DemoContext";
import { LoginModal } from "@/components/LoginModal";
import { PWARegister } from "@/components/PWARegister";
import { InstallPrompt } from "@/components/InstallPrompt";
import "./globals.css";

export const metadata: Metadata = {
  title: "ATNX — Attention Exchange",
  description: "Capture, identify, and track trending content with AI",
  applicationName: "ATNX",
  appleWebApp: {
    capable: true,
    title: "ATNX",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: "/app_icon.png",
    apple: "/app_icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#0A0A0A",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Inter:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-full flex flex-col font-mono">
        <ThemeProvider attribute="class" defaultTheme="dark" themes={["dark", "light"]}>
          <AuthProvider>
            <DemoProvider>
              {children}
              <LoginModal />
              <InstallPrompt />
            </DemoProvider>
          </AuthProvider>
        </ThemeProvider>
        <PWARegister />
      </body>
    </html>
  );
}
