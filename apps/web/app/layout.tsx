import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GA App",
  description: "General Aviation tooling — early scaffold.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
