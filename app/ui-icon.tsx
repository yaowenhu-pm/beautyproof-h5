import type { CSSProperties } from 'react';

export type IconName = 'link' | 'upload' | 'text' | 'arrow' | 'shield' | 'close' | 'check' | 'print' | 'info';
export default function Icon({name,className,style}:{name:IconName;className?:string;style?:CSSProperties}) {
 const paths:Record<IconName,React.ReactNode>={
  link:<><path d="M10 13a5 5 0 0 0 7 .1l3-3a5 5 0 0 0-7-7l-2 2"/><path d="M14 11a5 5 0 0 0-7-.1l-3 3a5 5 0 0 0 7 7l2-2"/></>,
  upload:<><path d="M12 16V3m-5 5 5-5 5 5M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"/></>,
  text:<><path d="M4 5h16M12 5v15M8 20h8M4 5v3m16-3v3"/></>,
  arrow:<path d="M4 12h16m-6-6 6 6-6 6"/>,
  shield:<><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="m8 12 3 3 5-6"/></>,
  close:<path d="m6 6 12 12M18 6 6 18"/>,
  check:<path d="m5 12 4 4L19 6"/>,
  print:<><path d="M6 9V3h12v6M6 18H3v-8h18v8h-3M6 15h12v6H6zM17 12h1"/></>,
  info:<><circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/></>,
 };
 return <svg className={className} style={style} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
