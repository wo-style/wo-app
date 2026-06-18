import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export const prepareDatabase = () => invoke("prepare_database");

export const onDownloadProgress = (cb) => listen("download-progress", (e) => cb(e.payload));

export const getSentenceExamples = (limit) => invoke("get_sentence_examples", { limit });

export const getWordFavorites = (kind, limit, page = 0) =>
    invoke("get_word_favorites", { kind, limit, page });

export const getSentenceFavorites = (limit, page = 0) =>
    invoke("get_sentence_favorites", { limit, page });

export const searchSentences = (word, limit, page = 0) =>
    invoke("search_sentences", { word, limit, page });

export const searchWords = (kind, word, limit, page = 0) =>
    invoke("search_words", { kind, word, limit, page });

export const saveSentence = (noun, verb) => invoke("save_sentence", { noun, verb });

export const deleteSentence = (noun, verb) => invoke("delete_sentence", { noun, verb });

export const saveWord = (kind, word) => invoke("save_word", { kind, word });

export const deleteWord = (kind, word) => invoke("delete_word", { kind, word });

export const generateRandomByFavorites = (limit) =>
    invoke("generate_random_by_favorites", { limit });

export const generateWithWordByFavorites = (fixedTable, targetTable, fixedWord, limit, page = 0) =>
    invoke("generate_with_word_by_favorites", { fixedTable, targetTable, fixedWord, limit, page });
