import { Icon } from "./lib/icons";

export function SidebarFooter({
  collapsed,
  theme,
  onThemeChange,
}: {
  collapsed: boolean;
  theme: "light" | "dark";
  onThemeChange: (theme: "light" | "dark") => void;
}) {
  return (
    <div className={`side-foot${collapsed ? " collapsed" : ""}`}>
      <div className="theme-seg">
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
