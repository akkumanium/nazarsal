import type { Metadata,Viewport } from "next";
import { Noto_Sans } from "next/font/google";
import "./globals.css";
import { LanguageProvider } from "@/components/language-provider";

const uiFont = Noto_Sans({
  subsets: ["latin", "cyrillic", "cyrillic-ext"],
  display: "swap",
  variable: "--font-ui",
});

export const metadata:Metadata={title:"NazarSal — маршруты по Астане",description:"Найдите места в Астане и спланируйте прогулку."};
export const viewport:Viewport={width:"device-width",initialScale:1,themeColor:"#f5f3ed"};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="ru" className={uiFont.variable}><body><LanguageProvider>{children}</LanguageProvider></body></html>;}
