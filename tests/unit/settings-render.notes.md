# New / Changed Props — App Integrator Notes

## Settings

```tsx
import type { Mode } from "@shared/types.ts";

interface SettingsProps {
  // — existing unchanged —
  settings: AppSettings;
  presets: ProviderPreset[];          // built-in + customProviders merged
  keys: Record<string, ApiKeyEntry[]>; // keyed by providerId
  skills: Skill[];
  connectors: McpServerConfig[];
  plugins: Plugin[];
  onSave: (patch: Partial<AppSettings>) => void;
  onRemoveKey: (keyId: string) => void;
  onToggleSkill: (id: string, enabled: boolean) => void;
  onToggleConnector: (id: string, enabled: boolean) => void;
  onTogglePlugin: (id: string, enabled: boolean) => void;
  onAddSkill: () => void;
  onAddConnector: () => void;
  onAddPlugin: () => void;
  onClose: () => void;

  // — NEW —

  /**
   * Called when user submits the add-key form.
   * Label is always ""; call bridge().providers.addKey(providerId, "", rawKey, meta).
   * meta contains { accountId } when preset.requiresAccountId === true (Cloudflare).
   * No label field anywhere — the old `label` argument is gone.
   */
  onAddKey: (
    providerId: string,
    rawKey: string,
    meta?: Record<string, string>,
  ) => void;

  /**
   * Opens CustomProviderDialog and saves via bridge().providers.addCustom().
   * Resolves when the provider has been saved; reject to show error in dialog.
   */
  onAddCustomProvider: (name: string, baseUrl: string) => Promise<void>;

  /** bridge().providers.removeCustom(id) */
  onRemoveCustomProvider: (id: string) => void;

  /**
   * Called when user clicks "Browse" in Cowork or Code pane.
   * App should: dialog.selectFolder() then save to settings.general.defaultFolders[mode].
   */
  onPickFolder: (mode: Mode) => void;

  /** Current value of standing rules (from bridge().memory.getRules()). */
  rules: string;

  /** Controlled updater for the rules textarea. */
  onRulesChange: (v: string) => void;

  /**
   * Called on textarea blur — App should call bridge().memory.setRules(rules).
   * Debouncing is handled in the blur handler, not in Settings.
   */
  onRulesBlur: () => void;

  /**
   * Pane to open on mount. Defaults to "general".
   * Pass "skills" when "Customize" is clicked so Settings opens directly there.
   */
  initialPane?: "general" | "providers" | "cowork" | "code" | "skills" | "connectors" | "plugins";
}
```

### Key behaviour changes
- **No label field** for any provider. `onAddKey` no longer receives a label. App calls `bridge().providers.addKey(providerId, "", rawKey, meta)`.
- **Cloudflare Workers** (`preset.requiresAccountId === true`): the form shows an "Account ID" field. The value is passed as `meta.accountId`.
- **Custom providers**: "+ Add custom" button at top of Providers pane opens `CustomProviderDialog`. Built-in + custom providers all appear in the same list.
- **Status badge**: coloured dot + text ("Valid", "Invalid", "Error", "Untested") — not colour alone.

---

## CodeHome

```tsx
interface CodeHomeProps {
  userName: string;
  /** Absolute folder paths currently open. */
  folders: string[];
  /** User clicked "+ Add another folder" → App calls dialog.selectFolder(). */
  onAddFolder: () => void;
  /** User clicked a folder chip → App can navigate to / open that folder. */
  onOpenFolder: (path: string) => void;
  /**
   * The full ComposerBar rendered by App.
   * Slotted in below the folder row; CodeHome does not know ComposerBar internals.
   */
  composerSlot: ReactNode;
}
```

### Removed props
- `modelLabel`, `onSubmit`, `onPickModel`, `onAttach`, `isRunning` — these all live inside `composerSlot` (ComposerBar). Remove them from the CodeHome call-site.

---

## Sidebar

```tsx
interface RecentItem {
  id: string;
  title: string;
  group?: string;
}

interface ConversationCallbacks {
  onOpen: (id: string) => void;                    // bridge().sessions.get + navigate
  onRename: (id: string, title: string) => void;   // bridge().sessions.rename
  onBranch: (id: string) => void;                  // bridge().sessions.branch
  onArchive: (id: string) => void;                 // bridge().sessions.archive
  onDelete: (id: string) => void;                  // bridge().sessions.delete
}

interface SidebarProps {
  // — existing unchanged —
  mode: Mode;
  onModeChange: (m: Mode) => void;
  active: NavKey;
  onNavigate: (k: NavKey) => void;
  recents: RecentItem[];           // shape is backward-compatible
  accountLabel: string;
  providerLabel: string;
  onAccountClick: () => void;
  onSelectRecent: (id: string) => void;

  // — NEW —
  /**
   * Wired to ConversationMenu on every recent row.
   * App wires each to the corresponding bridge().sessions.* method.
   */
  conversationCallbacks: ConversationCallbacks;
}
```

### Removed
- The dead `SlidersHorizontal` "Filter recents" button is gone. Replaced by a live `<input type="search">` that filters the list in-place.

---

## ConversationMenu

```tsx
interface ConversationMenuProps {
  currentTitle: string;                      // pre-populates the rename input
  onOpen: () => void;
  onRename: (title: string) => void;         // called only when title changed
  onBranch: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onClose: () => void;
}
```

Inline confirm step for Archive and Delete — no `window.confirm()`. Keyboard: Escape cancels/closes, Enter in rename input commits.

---

## CustomProviderDialog

```tsx
interface CustomProviderDialogProps {
  onSave: (name: string, baseUrl: string) => Promise<void>;
  onClose: () => void;
}
```

`onSave` should call `bridge().providers.addCustom({ name, baseUrl })` and resolve on success, reject on failure. The dialog shows an inline error on rejection.
