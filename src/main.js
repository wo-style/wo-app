import {
    prepareDatabase,
    onDownloadProgress,
    saveWord,
    deleteWord,
    getWordFavorites,
    getSentenceExamples,
    saveSentence,
    deleteSentence,
    getSentenceFavorites,
    searchWords,
    searchSentences,
    generateRandomByFavorites,
    generateWithWordByFavorites,
} from "./db.js";
import { onLongPress } from "./longpress.js";

let itemH = 28;
let viewsH = 0;
let footerH = 0;

let setMode = () => {};

let lastSearchKind = "noun";

let examplesView, nounsView, verbsView, sentencesView, generatedView, searchWordsView, searchExamplesView;
let nounsPager, verbsPager, sentencesPager, generatedPager, searchPager;
let searchForm, searchResultsWords, searchResultsExamples, searchTextEl;
let registerNoun, registerVerb, registerWo;

let statusEl = null;
const setStatus = (msg) => {
    statusEl ??= document.getElementById("status");
    if (statusEl) statusEl.textContent = msg;
};

const reportError = (err) => {
    console.error(err);
    setStatus(`エラー: ${err}`);
};

for (const ev of ["gesturestart", "gesturechange", "gestureend"]) {
    document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
}
let lastTouchEnd = 0;
document.addEventListener(
    "touchend",
    (e) => {
        const now = Date.now();
        if (now - lastTouchEnd <= 300) e.preventDefault();
        lastTouchEnd = now;
    },
    { passive: false },
);

const createListView = (ul, shape, handlers) => {
    const lis = [];
    const view = { items: [], deleted: [] };

    const addLi = () => {
        const idx = lis.length;
        const li = document.createElement("li");
        if (shape === "example" || shape === "generated") {
            const phrase = document.createElement("span");
            phrase.className = "phrase";
            const n = document.createElement("span");
            n.className = "word";
            const wo = document.createElement("span");
            wo.className = "particle";
            wo.textContent = "を";
            const v = document.createElement("span");
            v.className = "word";
            phrase.append(n, wo, v);
            li.append(phrase);
            li._noun = n;
            li._verb = v;
            li._phrase = phrase;
            n.dataset.role = "noun";
            v.dataset.role = "verb";
            n.addEventListener("click", () => handlers.onNoun?.(view, idx));
            v.addEventListener("click", () => handlers.onVerb?.(view, idx));
            wo.addEventListener("click", () => handlers.onParticle?.(view, idx));
        } else {
            li.className = "word-item";
            const t = document.createElement("span");
            t.className = "word";
            li.appendChild(t);
            li._text = t;
            li.addEventListener("click", () => handlers.onRow?.(view, idx));
        }
        li.style.display = "none";
        lis.push(li);
        ul.appendChild(li);
    };

    view.render = (items, limit) => {
        view.items = items;
        view.deleted = new Array(items.length).fill(false);
        while (lis.length < limit) addLi();
        for (let i = 0; i < lis.length; i++) {
            const li = lis[i];
            const row = i < limit ? items[i] : undefined;
            if (!row) {
                li.style.display = "none";
                continue;
            }
            if (shape === "example") {
                li._noun.textContent = row[0];
                li._verb.textContent = row[1];
                li._noun.classList.toggle("saved", row[2] === "1");
                li._verb.classList.toggle("saved", row[3] === "1");
            } else if (shape === "generated") {
                li._noun.textContent = row[0];
                li._verb.textContent = row[1];
                li._noun.classList.remove("deleted");
                li._verb.classList.remove("deleted");
                li._phrase.classList.toggle("saved", row[2] === "1");
            } else if (shape === "pair") {
                li._text.textContent = row[0] + " を " + row[1];
                li._text.classList.toggle("saved", row[2] === "1");
            } else {
                li._text.textContent = row[0];
                li.dataset.word = row[0];
            }
            li.classList.remove("deleted");
            li.style.display = "";
        }
    };

    view.setDeleted = (i, flag) => {
        view.deleted[i] = flag;
        if (lis[i]) lis[i].classList.toggle("deleted", flag);
    };

    view.setSaved = (i, which, flag) => {
        const li = lis[i];
        if (!li) return;
        const span = which === "noun" ? li._noun : li._verb;
        if (span) span.classList.toggle("saved", flag);
        const item = view.items[i];
        if (item) item[which === "noun" ? 2 : 3] = flag ? "1" : "0";
    };

    view.isWordDeleted = (i, which) =>
        !!(which === "noun" ? lis[i]?._noun : lis[i]?._verb)?.classList.contains("deleted");

    view.setWordDeleted = (i, which, flag) => {
        const span = which === "noun" ? lis[i]?._noun : lis[i]?._verb;
        span?.classList.toggle("deleted", flag);
    };

    view.setSentenceSaved = (i, flag) => {
        if (lis[i]?._phrase) lis[i]._phrase.classList.toggle("saved", flag);
        const item = view.items[i];
        if (item) item[2] = flag ? "1" : "0";
    };

    return view;
};

const makePager = (anchorUl) => {
    const footer = document.createElement("div");
    footer.className = "pager";
    const prev = document.createElement("button");
    prev.type = "button";
    prev.textContent = "◀︎";
    const next = document.createElement("button");
    next.type = "button";
    next.textContent = "▶︎";
    footer.append(prev, next);
    footer.style.display = "none";
    anchorUl.after(footer);

    let loader = null;
    let render = null;
    let page = 0;

    const show = async (p) => {
        if (!loader) return;
        try {
            let target = Math.max(0, p);
            let res = await loader(target);
            while ((res.items?.length ?? 0) === 0 && target > 0) {
                target -= 1;
                res = await loader(target);
            }
            page = res.page ?? target;
            render(res.items);
            prev.disabled = page <= 0;
            next.disabled = !res.hasNext;
            footer.style.display = "";
        } catch (err) {
            reportError(err);
        }
    };

    prev.addEventListener("click", () => show(page - 1));
    next.addEventListener("click", () => show(page + 1));

    return {
        load: (newLoader, newRender) => {
            loader = newLoader;
            render = newRender;
            return show(0);
        },
        reset: () => show(0),
        hideFooter: () => {
            footer.style.display = "none";
        },
    };
};

const wordToggleHandlers = (getKind) => ({
    onRow: async (view, i) => {
        const word = view.items[i]?.[0];
        if (word === undefined) return;
        const kind = getKind();
        try {
            if (view.deleted[i]) {
                await saveWord(kind, word);
                view.setDeleted(i, false);
                setStatus(`「${word}」を保存しました`);
            } else {
                await deleteWord(kind, word);
                view.setDeleted(i, true);
                setStatus(`「${word}」を削除しました`);
            }
        } catch (err) {
            reportError(err);
        }
    },
});

const sentenceToggleHandlers = {
    onRow: async (view, i) => {
        const row = view.items[i];
        if (!row) return;
        const [noun, verb] = row;
        try {
            if (view.deleted[i]) {
                await saveSentence(noun, verb);
                view.setDeleted(i, false);
                setStatus(`「${noun} を ${verb}」を保存しました`);
            } else {
                await deleteSentence(noun, verb);
                view.setDeleted(i, true);
                setStatus(`「${noun} を ${verb}」を削除しました`);
            }
        } catch (err) {
            reportError(err);
        }
    },
};

const makeGeneratedWord = (which) => async (view, i) => {
    const row = view.items[i];
    if (!row) return;
    const word = which === "noun" ? row[0] : row[1];
    const deleted = view.isWordDeleted(i, which);
    try {
        if (deleted) await saveWord(which, word);
        else await deleteWord(which, word);
        view.setWordDeleted(i, which, !deleted);
        setStatus(`「${word}」を${deleted ? "保存" : "削除"}しました`);
    } catch (err) {
        reportError(err);
    }
};

const generatedHandlers = {
    onNoun: makeGeneratedWord("noun"),
    onVerb: makeGeneratedWord("verb"),
    onParticle: async (view, i) => {
        const row = view.items[i];
        if (!row) return;
        const [noun, verb] = row;
        const saved = row[2] === "1";
        try {
            if (saved) await deleteSentence(noun, verb);
            else await saveSentence(noun, verb);
            view.setSentenceSaved(i, !saved);
            setStatus(`「${noun} を ${verb}」を名文${saved ? "から削除" : "に保存"}しました`);
        } catch (err) {
            reportError(err);
        }
    },
};

const makeExampleHandler = (which) => async (view, i) => {
    const row = view.items[i];
    if (!row) return;
    const word = which === "noun" ? row[0] : row[1];
    const saved = (which === "noun" ? row[2] : row[3]) === "1";
    try {
        if (saved) await deleteWord(which, word);
        else await saveWord(which, word);
        view.setSaved(i, which, !saved);
        setStatus(`「${word}」を${saved ? "削除" : "保存"}しました`);
    } catch (err) {
        reportError(err);
    }
};

const exampleHandlers = {
    onNoun: makeExampleHandler("noun"),
    onVerb: makeExampleHandler("verb"),
};

const measureMetrics = () => {
    const probe = document.createElement("div");
    probe.style.cssText = "position:absolute;left:-9999px;top:0;visibility:hidden;width:300px;";
    probe.innerHTML =
        '<div class="mode-panel" style="display:block">' +
        '<ul style="display:block"><li class="word-item">あ</li></ul>' +
        '<div class="pager"><button type="button">◀︎</button><button type="button">▶︎</button></div>' +
        "</div>";
    document.body.appendChild(probe);
    const item = probe.querySelector("li").offsetHeight || 28;
    const footer = probe.querySelector(".pager").offsetHeight || 0;
    document.body.removeChild(probe);
    return { item, footer };
};

const recomputeLimits = () => {
    const m = measureMetrics();
    itemH = m.item;
    footerH = m.footer;
    viewsH = document.querySelector(".views").clientHeight;
};

const listLimit = () => Math.max(1, Math.floor((viewsH - footerH) / itemH));

const reloadExamples = async () => {
    try {
        const limit = listLimit();
        const { items } = await getSentenceExamples(limit);
        examplesView.render(items, limit);
        setStatus("例文を取得しました");
    } catch (err) {
        reportError(err);
    }
};

const regenerateFavorites = async () => {
    try {
        const limit = listLimit();
        const { items } = await generateRandomByFavorites(limit);
        generatedPager.hideFooter();
        generatedView.render(items, limit);
        setStatus("保存した名詞と動詞でランダム作文しました");
    } catch (err) {
        reportError(err);
    }
};

const setupModes = () => {
    const buttons = [...document.querySelectorAll("#modes .mode-button")];
    const panels = [...document.querySelectorAll(".mode-panel")];

    const reloaders = {
        examples: reloadExamples,
        generated: regenerateFavorites,
        nouns: () => nounsPager.reset(),
        verbs: () => verbsPager.reset(),
        sentences: () => sentencesPager.reset(),
    };

    setMode = (mode) => {
        for (const btn of buttons) btn.classList.toggle("selected", btn.dataset.mode === mode);
        for (const panel of panels) panel.classList.toggle("active", panel.dataset.mode === mode);
    };

    for (const btn of buttons) {
        btn.addEventListener("click", async () => {
            const mode = btn.dataset.mode;
            await reloaders[mode]?.();
            setMode(mode);
            if (mode === "search") showSearchInput();
            setStatus(`${btn.textContent}モードに切り替えました`);
        });
    }

    if (buttons.length > 0) setMode(buttons[0].dataset.mode);
};

const showSearchInput = () => {
    searchForm.style.display = "";
    searchResultsWords.style.display = "none";
    searchResultsExamples.style.display = "none";
    searchPager.hideFooter();
};

const showSearchResults = (type) => {
    searchForm.style.display = "none";
    const isExample = type === "sentence_example";
    searchResultsWords.style.display = isExample ? "none" : "";
    searchResultsExamples.style.display = isExample ? "" : "none";
};

const runSearch = async () => {
    const checked = document.querySelector('input[name="search-type"]:checked');
    const type = checked ? checked.value : "sentence_example";
    const word = searchTextEl.value.trim();
    if (!word) return;
    try {
        if (type === "sentence_example") {
            await searchPager.load(
                (p) => searchSentences(word, listLimit(), p),
                (items) => searchExamplesView.render(items, listLimit()),
            );
            setStatus(`「${word}」を含む例文を検索しました`);
        } else {
            lastSearchKind = type;
            await searchPager.load(
                (p) => searchWords(type, word, listLimit(), p),
                (items) => searchWordsView.render(items, listLimit()),
            );
            setStatus(`「${word}」を含む${type === "noun" ? "名詞" : "動詞"}を検索しました`);
        }
        showSearchResults(type);
    } catch (err) {
        reportError(err);
    }
};

const setupSearch = () => {
    searchForm = document.getElementById("search-form");
    searchResultsWords = document.getElementById("search-results-words");
    searchResultsExamples = document.getElementById("search-results-examples");
    searchTextEl = document.getElementById("search-text");
    searchForm?.addEventListener("submit", (e) => {
        e.preventDefault();
        runSearch();
    });
};

const registerType = () =>
    document.querySelector('input[name="register-type"]:checked')?.value ?? "noun";

const updateRegisterInputs = (type) => {
    registerNoun.style.display = type === "verb" ? "none" : "";
    registerVerb.style.display = type === "noun" ? "none" : "";
    registerWo.style.display = type === "sentence" ? "" : "none";
};

const runRegister = async () => {
    const type = registerType();
    const noun = registerNoun.value.trim();
    const verb = registerVerb.value.trim();
    try {
        if (type === "sentence") {
            if (!noun || !verb) return;
            await saveSentence(noun, verb);
            setStatus(`「${noun} を ${verb}」を名文に登録しました`);
        } else if (type === "noun") {
            if (!noun) return;
            await saveWord("noun", noun);
            setStatus(`「${noun}」を名詞に登録しました`);
        } else {
            if (!verb) return;
            await saveWord("verb", verb);
            setStatus(`「${verb}」を動詞に登録しました`);
        }
        registerNoun.value = "";
        registerVerb.value = "";
        (type === "verb" ? registerVerb : registerNoun).focus();
    } catch (err) {
        reportError(err);
    }
};

const setupRegister = () => {
    registerNoun = document.getElementById("register-noun");
    registerVerb = document.getElementById("register-verb");
    registerWo = document.getElementById("register-wo");
    document.getElementById("register-form")?.addEventListener("submit", (e) => {
        e.preventDefault();
        runRegister();
    });
    document.querySelectorAll('input[name="register-type"]').forEach((radio) => {
        radio.addEventListener("change", () => updateRegisterInputs(registerType()));
    });
    updateRegisterInputs(registerType());
};

const composeWithWord = async (kind, word) => {
    if (!kind || !word) return;
    const target = kind === "noun" ? "verb" : "noun";
    const targetName = kind === "noun" ? "動詞" : "名詞";
    try {
        await generatedPager.load(
            (p) => generateWithWordByFavorites(kind, target, word, listLimit(), p),
            (items) => generatedView.render(items, listLimit()),
        );
        setMode("generated");
        setStatus(`「${word}」と全ての${targetName}で作文しました`);
    } catch (err) {
        reportError(err);
    }
};

const setupWordLongPress = (kind) => {
    const ul = document.getElementById(kind === "noun" ? "nouns" : "verbs");
    if (!ul) return;
    onLongPress(ul, (li) => composeWithWord(kind, li.dataset.word), { selector: ".word-item" });
};

const setupGeneratedLongPress = () => {
    const ul = document.getElementById("generated");
    if (!ul) return;
    onLongPress(ul, (el) => composeWithWord(el.dataset.role, el.textContent), { selector: ".word" });
};

window.addEventListener("DOMContentLoaded", async () => {
    examplesView = createListView(document.getElementById("examples"), "example", exampleHandlers);
    nounsView = createListView(
        document.getElementById("nouns"),
        "word",
        wordToggleHandlers(() => "noun"),
    );
    verbsView = createListView(
        document.getElementById("verbs"),
        "word",
        wordToggleHandlers(() => "verb"),
    );
    sentencesView = createListView(document.getElementById("sentences"), "pair", sentenceToggleHandlers);
    generatedView = createListView(document.getElementById("generated"), "generated", generatedHandlers);
    searchWordsView = createListView(
        document.getElementById("search-results-words"),
        "word",
        wordToggleHandlers(() => lastSearchKind),
    );
    searchExamplesView = createListView(document.getElementById("search-results-examples"), "example", exampleHandlers);

    nounsPager = makePager(document.getElementById("nouns"));
    verbsPager = makePager(document.getElementById("verbs"));
    sentencesPager = makePager(document.getElementById("sentences"));
    generatedPager = makePager(document.getElementById("generated"));
    searchPager = makePager(document.getElementById("search-results-examples"));

    setupModes();
    setupSearch();
    setupRegister();
    setupWordLongPress("noun");
    setupWordLongPress("verb");
    setupGeneratedLongPress();

    if (document.fonts?.ready) {
        try {
            await document.fonts.ready;
        } catch {}
    }
    recomputeLimits();

    let unlisten;
    try {
        unlisten = await onDownloadProgress((pct) => {
            setStatus(`データベースをダウンロードしています...（${pct}%）`);
        });

        setStatus("データベースを準備しています...");
        await prepareDatabase();

        setStatus("データを読み込んでいます...");
        await Promise.all([
            reloadExamples(),
            regenerateFavorites(),
            nounsPager.load(
                (p) => getWordFavorites("noun", listLimit(), p),
                (items) => nounsView.render(items, listLimit()),
            ),
            verbsPager.load(
                (p) => getWordFavorites("verb", listLimit(), p),
                (items) => verbsView.render(items, listLimit()),
            ),
            sentencesPager.load(
                (p) => getSentenceFavorites(listLimit(), p),
                (items) => sentencesView.render(items, listLimit()),
            ),
        ]);

        setStatus("ようこそ「を研究所」へ");
    } catch (err) {
        reportError(err);
    } finally {
        if (unlisten) unlisten();
    }
});
