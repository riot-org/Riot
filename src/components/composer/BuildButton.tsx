import { useState } from "react";

import { useT } from "../../i18n";
import { Chevron } from "../Chevron";
import { MultitaskIcon, PlayIcon } from "../icons";
import { useDropdown } from "../pickers";

/**
 * 「构建」：主键 + 右侧一枚小箭头拉出「并行构建」（Cursor 的 Build ▾）。
 *
 * 主键就是最常见的那条路（自己按计划做）；并行是进阶选项，藏进菜单 ——
 * 两个等重的键并排，用户每次都要停下来想一下差别。
 */
export function BuildButton({
  disabled,
  onBuild,
  onBuildParallel,
}: {
  disabled: boolean;
  onBuild: () => void;
  onBuildParallel: () => void;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const { rootRef, onKeyDown } = useDropdown(open, setOpen);
  return (
    <div className="mode-menu build-menu" ref={rootRef} onKeyDown={onKeyDown}>
      <div className="build-split">
        <button
          type="button"
          className="build-btn"
          disabled={disabled}
          onClick={onBuild}
          title={t("composer.build.title")}
        >
          <PlayIcon />
          <span>{t("composer.build")}</span>
        </button>
        <button
          type="button"
          className="build-more"
          disabled={disabled}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={t("composer.build.more")}
          title={t("composer.build.more")}
          onClick={() => setOpen(!open)}
        >
          <Chevron down open={open} />
        </button>
      </div>
      {open ? (
        <div className="menu menu-right" role="menu">
          <button
            type="button"
            role="menuitem"
            className="menu-item menu-pick"
            onClick={() => {
              setOpen(false);
              onBuildParallel();
            }}
          >
            <span className="menu-pick-body">
              <span className="menu-pick-label">
                <span className="pill-mark pill-multitask" aria-hidden>
                  <MultitaskIcon />
                </span>
                {t("composer.build.parallel")}
              </span>
              <span className="menu-hint">{t("composer.build.parallelHint")}</span>
            </span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

