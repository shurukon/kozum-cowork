import type { ReactNode, SVGProps } from "react";
import { toolIcon } from "../lib/toolIcons.ts";

export interface ToolGlyphProps extends SVGProps<SVGSVGElement> {
  toolName: string;
  size?: number;
}

/**
 * Kozum's tool language: small inline SVGs with a shared stroke system, rather
 * than a generic icon-font lookup. The semantic icon is selected from the
 * actual tool name, so every registered tool has a stable visual identity in
 * the transcript and remains legible without color alone.
 */
export function ToolGlyph({ toolName, size = 16, ...props }: ToolGlyphProps) {
  const icon = toolIcon(toolName).icon;
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  let body: ReactNode;
  switch (icon) {
    case "terminal":
      body = <><rect x="2.5" y="3" width="19" height="18" rx="3" {...common} /><path d="m6 8 3.5 3L6 14" {...common} /><path d="M12 15.5h5" {...common} /></>;
      break;
    case "file-text":
      body = <><path d="M6 2.8h8l4 4V21H6z" {...common} /><path d="M14 2.8v4h4M9 11h6M9 15h6M9 18h4" {...common} /></>;
      break;
    case "file-plus":
      body = <><path d="M6 2.8h8l4 4V21H6z" {...common} /><path d="M14 2.8v4h4M9 15h6M12 12v6" {...common} /></>;
      break;
    case "file-minus":
    case "trash-2":
      body = <><path d="M6 6h12l-1 15H7zM9 6V3h6v3M4 6h16" {...common} /><path d="M9.5 11v6M14.5 11v6" {...common} /></>;
      break;
    case "file-pen":
      body = <><path d="M6 3h8l4 4v7" {...common} /><path d="M14 3v4h4M6 21h5" {...common} /><path d="m13 18 5.8-5.8 2 2L15 20z" {...common} /></>;
      break;
    case "file-search":
    case "search":
      body = <><circle cx="10.5" cy="10.5" r="6.5" {...common} /><path d="m16 16 5 5M7.5 10.5h6" {...common} /></>;
      break;
    case "folder-plus":
    case "folder-open":
    case "folder":
      body = <><path d="M3 7.5h7l2 2h9v9.2a2.3 2.3 0 0 1-2.3 2.3H5.3A2.3 2.3 0 0 1 3 18.7z" {...common} /><path d="M3 7.5V5.8A2.3 2.3 0 0 1 5.3 3.5h4l2 2H19" {...common} />{icon === "folder-plus" && <path d="M12.5 12v5M10 14.5h5" {...common} />}</>;
      break;
    case "globe":
      body = <><circle cx="12" cy="12" r="8.7" {...common} /><path d="M3.8 12h16.4M12 3.3c2.4 2.4 3.5 5.3 3.5 8.7s-1.1 6.3-3.5 8.7c-2.4-2.4-3.5-5.3-3.5-8.7s1.1-6.3 3.5-8.7z" {...common} /></>;
      break;
    case "compass":
      body = <><circle cx="12" cy="12" r="9" {...common} /><path d="m15.7 8.3-2.1 5.3-5.3 2.1 2.1-5.3z" {...common} /></>;
      break;
    case "camera":
      body = <><path d="M4 8h3l1.4-2h7.2L17 8h3v11H4z" {...common} /><circle cx="12" cy="13.5" r="3.2" {...common} /></>;
      break;
    case "mouse-pointer-2":
      body = <><path d="m5 3 12.5 8.3-5.4 1.4 2.7 5.2-2.5 1.3-2.7-5.2-3.5 4z" {...common} /><circle cx="18.5" cy="5.5" r="2" {...common} /></>;
      break;
    case "keyboard":
      body = <><rect x="2.5" y="6" width="19" height="12" rx="2.2" {...common} /><path d="M6 10h.1M9 10h.1M12 10h.1M15 10h.1M18 10h.1M6 14h8M16 14h2" {...common} /></>;
      break;
    case "monitor":
      body = <><rect x="3" y="4" width="18" height="13" rx="2" {...common} /><path d="M8 21h8M12 17v4" {...common} /><circle cx="12" cy="10.5" r="2.5" {...common} /></>;
      break;
    case "bot":
      body = <><rect x="4" y="7" width="16" height="12" rx="4" {...common} /><path d="M12 7V3M9 3h6M8.5 12h.1M15.5 12h.1M8 16h8" {...common} /></>;
      break;
    case "list-checks":
      body = <><path d="M9 6h11M9 12h11M9 18h11" {...common} /><path d="m3 6 1.5 1.5L6.8 5M3 12l1.5 1.5L6.8 11M3 18l1.5 1.5L6.8 17" {...common} /></>;
      break;
    case "sparkles":
      body = <><path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5zM19 16v5M16.5 18.5h5" {...common} /></>;
      break;
    case "plug":
      body = <><path d="M8 3v6M16 3v6M6 8h12v2a6 6 0 0 1-12 0zM12 16v5" {...common} /></>;
      break;
    case "package":
      body = <><path d="m12 3 8 4.2v9.6L12 21l-8-4.2V7.2z" {...common} /><path d="m4 7.2 8 4.1 8-4.1M12 11.3V21" {...common} /></>;
      break;
    case "calendar":
      body = <><rect x="3" y="5" width="18" height="16" rx="2" {...common} /><path d="M7 3v4M17 3v4M3 10h18M8 14h.1M12 14h.1M16 14h.1M8 18h.1M12 18h.1" {...common} /></>;
      break;
    case "brain":
      body = <><path d="M9.5 5.2A3.2 3.2 0 0 0 4 7.5a3.4 3.4 0 0 0 .2 9.1A3.2 3.2 0 0 0 9.5 19zM14.5 5.2A3.2 3.2 0 0 1 20 7.5a3.4 3.4 0 0 1-.2 9.1 3.2 3.2 0 0 1-5.3 2.4z" {...common} /><path d="M12 5v14M8 9h2M14 9h2M8 14h2M14 14h2" {...common} /></>;
      break;
    case "clock":
      body = <><circle cx="12" cy="12" r="8.7" {...common} /><path d="M12 7v5l3 2" {...common} /></>;
      break;
    case "list":
      body = <><path d="M8 6h12M8 12h12M8 18h12M3 6h.1M3 12h.1M3 18h.1" {...common} /></>;
      break;
    case "download":
      body = <><path d="M12 3v12M7 10l5 5 5-5M4 20h16" {...common} /></>;
      break;
    case "activity":
      body = <><path d="M3 12h4l2-6 4 12 2-6h6" {...common} /></>;
      break;
    case "square":
      body = <><rect x="6" y="6" width="12" height="12" rx="2" {...common} /><path d="M9 9h6v6H9z" {...common} /></>;
      break;
    case "x-circle":
      body = <><circle cx="12" cy="12" r="8.7" {...common} /><path d="m9 9 6 6M15 9l-6 6" {...common} /></>;
      break;
    case "play":
      body = <><circle cx="12" cy="12" r="8.7" {...common} /><path d="m10 8.5 5.5 3.5-5.5 3.5z" {...common} /></>;
      break;
    case "copy":
      body = <><rect x="8" y="8" width="11" height="12" rx="2" {...common} /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2" {...common} /></>;
      break;
    case "move":
      body = <><path d="M12 3v18M3 12h18M12 3l-2 2M12 3l2 2M12 21l-2-2M12 21l2-2M3 12l2-2M3 12l2 2M21 12l-2-2M21 12l-2 2" {...common} /></>;
      break;
    case "lock":
      body = <><rect x="5" y="10" width="14" height="11" rx="2" {...common} /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" {...common} /></>;
      break;
    case "files":
      body = <><path d="M7 4h9l3 3v13H7z" {...common} /><path d="M7 8H5v13h10M16 4v4h3" {...common} /><path d="M10 12h6M10 16h6" {...common} /></>;
      break;
    case "folder-minus":
    case "folder-search":
      body = <><path d="M3 7.5h7l2 2h9v9.2a2.3 2.3 0 0 1-2.3 2.3H5.3A2.3 2.3 0 0 1 3 18.7z" {...common} /><path d="M3 7.5V5.8A2.3 2.3 0 0 1 5.3 3.5h4l2 2H19" {...common} />{icon === "folder-search" ? <><circle cx="12" cy="14" r="2.5" {...common} /><path d="m14 16 2 2" {...common} /></> : <path d="M10 14h5" {...common} />}</>;
      break;
    case "eye":
      body = <><path d="M2.8 12s3.3-5 9.2-5 9.2 5 9.2 5-3.3 5-9.2 5-9.2-5-9.2-5z" {...common} /><circle cx="12" cy="12" r="2" {...common} /></>;
      break;
    case "code-2":
      body = <><path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14" {...common} /></>;
      break;
    case "scroll":
      body = <><path d="M7 5v13a3 3 0 0 0 3 3h7a3 3 0 0 0 3-3V5a3 3 0 0 0-3-3h-7a3 3 0 0 0-3 3z" {...common} /><path d="M7 6H5a2 2 0 0 0 0 4h2M11 7h5M11 11h5M11 15h4" {...common} /></>;
      break;
    case "check-square":
      body = <><rect x="4" y="4" width="16" height="16" rx="2" {...common} /><path d="m8 12 2.5 2.5L16 9" {...common} /></>;
      break;
    case "arrow-left":
    case "arrow-right":
      body = icon === "arrow-left" ? <path d="M19 12H5M11 6l-6 6 6 6" {...common} /> : <path d="M5 12h14M13 6l6 6-6 6" {...common} />;
      break;
    case "x":
      body = <><path d="m7 7 10 10M17 7 7 17" {...common} /></>;
      break;
    case "plus":
      body = <><path d="M12 5v14M5 12h14" {...common} /></>;
      break;
    case "layers":
      body = <><path d="m12 3 8 4-8 4-8-4zM4 12l8 4 8-4M4 17l8 4 8-4" {...common} /></>;
      break;
    case "clipboard":
      body = <><rect x="5" y="5" width="14" height="16" rx="2" {...common} /><path d="M9 5V3h6v2M8 10h8M8 14h8M8 18h5" {...common} /></>;
      break;
    case "file":
      body = <><path d="M6 3h8l4 4v14H6z" {...common} /><path d="M14 3v4h4" {...common} /></>;
      break;
    case "wrench":
    default:
      body = <><path d="M14.5 6.5a4.5 4.5 0 0 0-5.7 5.7l-5.3 5.3a2 2 0 0 0 2.8 2.8l5.3-5.3a4.5 4.5 0 0 0 5.7-5.7l-3 3-2.5-.5-.5-2.5z" {...common} /></>;
      break;
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label={toolIcon(toolName).label}
      data-tool-glyph={toolName}
      {...props}
    >
      {body}
    </svg>
  );
}
