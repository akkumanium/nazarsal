import type { Metadata,Viewport } from "next";
import { Manrope } from "next/font/google";
import "./globals.css";
import { LanguageProvider } from "@/components/language-provider";

const manrope = Manrope({
  subsets: ["latin", "cyrillic"],
  display: "swap",
  variable: "--font-manrope",
});

export const metadata:Metadata={title:"NazarSal — маршруты по Астане",description:"Найдите места в Астане и спланируйте прогулку."};
export const viewport:Viewport={width:"device-width",initialScale:1,themeColor:"#f5f3ed"};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="ru" className={manrope.variable}><body><LanguageProvider>{children}</LanguageProvider></body></html>;}
