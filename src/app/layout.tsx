import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "HomeGrid | Smart living. Reliable by design.",
    template: "%s | HomeGrid",
  },
  description: "A clear, dependable foundation for connected home experiences.",
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
