import "@/styles/globals.css";

import { type Metadata } from "next";
import { Geist, Playfair_Display } from "next/font/google";

import { TRPCReactProvider } from "@/trpc/react";
import { PostHogProvider } from "@/app/_components/posthog-provider";

export const metadata: Metadata = {
  title: "Pathway | Restaurant Intelligence",
  description:
    "Plan staffing and prep for the next 3 days across your NYC locations.",
  icons: [{ rel: "icon", url: "/favicon.ico" }],
};

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
});

const playfair = Playfair_Display({
  subsets: ["latin"],
  variable: "--font-playfair",
  style: ["normal", "italic"],
});

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${geist.variable} ${playfair.variable}`}>
      <body>
        <TRPCReactProvider>
          <PostHogProvider>{children}</PostHogProvider>
        </TRPCReactProvider>
      </body>
    </html>
  );
}
