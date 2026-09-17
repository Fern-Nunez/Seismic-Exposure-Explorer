"use client";
import dynamic from "next/dynamic";

const SeismicExplorer = dynamic(() => import("@/components/SeismicExplorer"), { ssr: false });

export default function Home() {
  return <SeismicExplorer />;
}