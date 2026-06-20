export const onLongPress = (root, onPress, options = {}) => {
    const { duration = 500, selector = null, moveTolerance = 10, suppressClick = true } = options;

    let timer = null;
    let startX = 0;
    let startY = 0;
    let pressedEl = null;
    let fired = false;

    const resolve = (target) => {
        if (!(target instanceof Element)) return null;
        if (!selector) return target;
        const match = target.closest(selector);
        return match && root.contains(match) ? match : null;
    };

    const cancel = () => {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
        pressedEl = null;
    };

    const onPointerDown = (e) => {
        fired = false;
        if (e.button !== undefined && e.button !== 0) return;
        const el = resolve(e.target);
        if (!el) return;
        pressedEl = el;
        startX = e.clientX;
        startY = e.clientY;
        timer = setTimeout(() => {
            timer = null;
            fired = true;
            const el = pressedEl;
            pressedEl = null;
            onPress(el, e);
        }, duration);
    };

    const onPointerMove = (e) => {
        if (timer === null) return;
        if (Math.abs(e.clientX - startX) > moveTolerance || Math.abs(e.clientY - startY) > moveTolerance) {
            cancel();
        }
    };

    const onClick = (e) => {
        if (fired) {
            e.preventDefault();
            e.stopPropagation();
            fired = false;
        }
    };

    const onContextMenu = (e) => {
        if (resolve(e.target)) e.preventDefault();
    };

    root.addEventListener("pointerdown", onPointerDown);
    root.addEventListener("pointermove", onPointerMove);
    root.addEventListener("pointerup", cancel);
    root.addEventListener("pointercancel", cancel);
    root.addEventListener("pointerleave", cancel);
    if (suppressClick) root.addEventListener("click", onClick, true);
    root.addEventListener("contextmenu", onContextMenu);

    return () => {
        cancel();
        root.removeEventListener("pointerdown", onPointerDown);
        root.removeEventListener("pointermove", onPointerMove);
        root.removeEventListener("pointerup", cancel);
        root.removeEventListener("pointercancel", cancel);
        root.removeEventListener("pointerleave", cancel);
        if (suppressClick) root.removeEventListener("click", onClick, true);
        root.removeEventListener("contextmenu", onContextMenu);
    };
};
