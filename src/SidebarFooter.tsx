import { Icon } from "./lib/icons";
import { useSegPill } from "./lib/transitions";

export function SidebarFooter({
  collapsed,
  theme,
  onThemeChange,
}: {
  collapsed: boolean;
  theme: "light" | "dark";
  onThemeChange: (theme: "light" | "dark") => void;
}) {
  // The bar turns vertical when the sidebar collapses, so re-measure on both.
  const segRef = useSegPill<HTMLDivElement>(`${theme}:${collapsed}`);
  return (
    <div className={`side-foot${collapsed ? " collapsed" : ""}`}>
      <div className="theme-seg" ref={segRef}>
        <span className="t-tabs-pill" aria-hidden="true" />
        <button
          className={theme === "light" ? "on" : ""}
          title="Light"
          onClick={() => onThemeChange("light")}
        >
          <Icon name="sun" size={16} />
        </button>
        <button
          className={theme === "dark" ? "on" : ""}
          title="Dark"
          onClick={() => onThemeChange("dark")}
        >
          <Icon name="moon" size={16} />
        </button>
      </div>
    </div>
  );
}
