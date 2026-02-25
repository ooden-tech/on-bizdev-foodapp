import type { Metadata } from "next";
import { GeistSans, GeistMono } from 'geist/font';
import "./globals.css";
import { AuthProvider } from "@/context/AuthContext";
import { ProfileProvider } from "@/context/ProfileContext";

const geistSans = GeistSans;
const geistMono = GeistMono;

export const metadata: Metadata = {
  title: "NutriPal Web",
  description: "Your personal nutrition assistant - Web Version",
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
        <AuthProvider>
          <ProfileProvider>
            {children}
          </ProfileProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
