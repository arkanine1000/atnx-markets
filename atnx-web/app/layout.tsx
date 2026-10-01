import type { Metadata, Viewport } from "next";
import { Archivo, Instrument_Sans, Martian_Mono } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { AuthProvider } from "@/context/AuthContext";
import { headers } from "next/headers";
import { cookieToInitialState } from "wagmi";
import { wagmiConfig } from "@/lib/bm/wagmi";
import { Web3Providers } from "@/components/bm/Web3Providers";
import { AutoWalletSignIn } from "@/components/bm/AutoWalletSignIn";
import { LoginModal } from "@/components/LoginModal";
import { PWARegister } from "@/components/PWARegister";
import { InstallPrompt } from "@/components/InstallPrompt";
import "./globals.css";

// Display and wordmark.
const archivo = Archivo({
  subsets: ["latin"],
  variable: "--font-archivo",
  display: "swap",
});

// Body copy, headings' supporting text, buttons.
const instrumentSans = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-instrument-sans",
  display: "swap",
});

// Anything that reads as data: numbers, tickers, chips, tags, table cells,
// uppercase labels.
const martianMono = Martian_Mono({
  subsets: ["latin"],
  variable: "--font-martian-mono",
  display: "swap",
});

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

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // The wallet connection wagmi stored in its cookie, so the first paint
  // already knows it (see lib/bm/wagmi.ts).
  const wagmiState = cookieToInitialState(wagmiConfig, (await headers()).get("cookie"));
  return (
    <html
      lang="en"
      className={`h-full antialiased ${archivo.variable} ${instrumentSans.variable} ${martianMono.variable}`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col font-sans">
        <ThemeProvider attribute="class" defaultTheme="dark" themes={["dark", "light"]}>
          <Web3Providers initialState={wagmiState}>
            <AuthProvider>
              {children}
              <LoginModal />
              <AutoWalletSignIn />
              <InstallPrompt />
            </AuthProvider>
          </Web3Providers>
        </ThemeProvider>
        <PWARegister />
      </body>
    </html>
  );
}
