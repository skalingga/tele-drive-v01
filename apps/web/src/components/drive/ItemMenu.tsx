import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LucideIcon } from "lucide-react";
import type { FileItem, Folder } from "@teledrive/shared";

export type DriveItem = { type: "file"; file: FileItem } | { type: "folder"; folder: Folder };

export const driveItemId = (item: DriveItem) => (item.type === "file" ? item.file.id : item.folder.id);
export const driveItemName = (item: DriveItem) => (item.type === "file" ? item.file.name : item.folder.name);

/** Props shared by the grid and list views; every action goes through the one menu owned by App. */
export interface DriveViewProps {
  folders: Folder[];
  files: FileItem[];
  isTrash: boolean;
  /** Double-click / Enter: open a folder, preview a ready file. */
  onActivate: (item: DriveItem) => void;
  onOpenMenu: (item: DriveItem, anchor: MenuAnchor) => void;
  /** Delete key: trash (or nothing in the trash view). */
  onDelete: (item: DriveItem) => void;
  onToggleStar: (file: FileItem) => void;
  onMoveItem: (type: "file" | "folder", id: string, targetFolderId: string | null) => void;
}

/** Where the menu opens: a point (right-click) or the corner of a ⋮ button (align "end" = menu's right edge there). */
export interface MenuAnchor {
  x: number;
  y: number;
  align: "start" | "end";
}

export interface MenuAction {
  key: string;
  label: string;
  icon: LucideIcon;
  danger?: boolean;
  onSelect: () => void;
}

interface ItemMenuProps {
  anchor: MenuAnchor;
  actions: MenuAction[];
  onClose: () => void;
}

const VIEWPORT_MARGIN = 8;

/**
 * Context menu rendered in a portal with fixed positioning, so it is never clipped by the scroll container
 * or covered by neighbouring rows (rows use transforms, which create stacking contexts).
 * Closes on outside press, Escape, scroll, resize and window blur — but NOT on presses inside itself,
 * otherwise the menu would unmount between mousedown and click and the chosen action would never run.
 */
export const ItemMenu: React.FC<ItemMenuProps> = ({ anchor, actions, onClose }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    let left = anchor.align === "end" ? anchor.x - width : anchor.x;
    let top = anchor.y + 4;
    if (top + height > window.innerHeight - VIEWPORT_MARGIN) top = Math.max(VIEWPORT_MARGIN, anchor.y - height - 4);
    left = Math.min(Math.max(VIEWPORT_MARGIN, left), window.innerWidth - width - VIEWPORT_MARGIN);
    setPos({ left, top });
  }, [anchor]);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();

    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    const onScroll = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [onClose]);

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const focus = (n: number) => buttons[(n + buttons.length) % buttons.length]?.focus();
    if (e.key === "ArrowDown") focus(i + 1);
    else if (e.key === "ArrowUp") focus(i - 1);
    else if (e.key === "Home") focus(0);
    else if (e.key === "End") focus(buttons.length - 1);
    else if (e.key === "Tab") onClose();
    else return;
    e.preventDefault();
  };

  return createPortal(
    <div
      ref={ref}
      role="menu"
      onKeyDown={onMenuKeyDown}
      onContextMenu={e => e.preventDefault()}
      className="td-context-menu"
      style={{ position: "fixed", left: pos?.left ?? anchor.x, top: pos?.top ?? anchor.y, visibility: pos ? "visible" : "hidden" }}
    >
      {actions.map(({ key, label, icon: Icon, danger, onSelect }) => (
        <button
          key={key}
          type="button"
          role="menuitem"
          className={`td-context-item ${danger ? "is-danger" : ""}`}
          onClick={() => {
            onClose();
            onSelect();
          }}
        >
          <Icon className="w-4 h-4 shrink-0" />
          <span>{label}</span>
        </button>
      ))}
    </div>,
    document.body
  );
};

/** Anchor for a ⋮ button: the menu's right edge lines up with the button's right edge, just below it. */
export function anchorFromElement(el: Element): MenuAnchor {
  const r = el.getBoundingClientRect();
  return { x: r.right, y: r.bottom, align: "end" };
}

/** Keyboard on a focused row/card: Enter opens, Delete trashes, Shift+F10 / ContextMenu opens the menu. */
export function itemKeyHandler(
  item: DriveItem,
  handlers: { onActivate: (item: DriveItem) => void; onOpenMenu: (item: DriveItem, anchor: MenuAnchor) => void; onDelete: (item: DriveItem) => void }
) {
  return (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return; // keys typed on the inner buttons keep their own meaning
    if (e.key === "Enter") handlers.onActivate(item);
    else if (e.key === "Delete") handlers.onDelete(item);
    else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      const r = e.currentTarget.getBoundingClientRect();
      handlers.onOpenMenu(item, { x: r.left + 24, y: r.top + r.height / 2, align: "start" });
    } else return;
    e.preventDefault();
  };
}
