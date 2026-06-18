mod db;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use futures_util::StreamExt;
use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncWriteExt;

#[derive(Default)]
struct AppState {
    conn: Mutex<Option<Connection>>,
}

#[derive(Debug, thiserror::Error)]
enum CommandError {
    #[error(transparent)]
    Db(#[from] db::DbError),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error("HTTP エラー: {0}")]
    Http(String),
    #[error("IO エラー: {0}")]
    Io(String),
    #[error("データベースの準備ができていません")]
    NotReady,
    #[error("アプリのデータディレクトリを取得できませんでした")]
    NoDataDir,
}

impl Serialize for CommandError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

type CmdResult<T> = Result<T, CommandError>;

fn with_conn<T>(state: &State<AppState>, f: impl FnOnce(&Connection) -> Result<T, db::DbError>) -> CmdResult<T> {
    let guard = state.conn.lock().unwrap();
    let conn = guard.as_ref().ok_or(CommandError::NotReady)?;
    Ok(f(conn)?)
}

fn db_path(app: &AppHandle) -> CmdResult<PathBuf> {
    let dir = app.path().app_data_dir().map_err(|_| CommandError::NoDataDir)?;
    Ok(dir.join(db::DB_FILENAME))
}

async fn download_db(app: &AppHandle, path: &Path) -> CmdResult<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| CommandError::Io(e.to_string()))?;
    }
    let _ = tokio::fs::remove_file(path).await;

    let resp = reqwest::get(db::DB_URL)
        .await
        .map_err(|e| CommandError::Http(e.to_string()))?;
    if !resp.status().is_success() {
        return Err(CommandError::Http(format!(
            "データベースのダウンロードに失敗しました: {}",
            resp.status()
        )));
    }
    let total = resp.content_length().unwrap_or(0);
    let tmp = path.with_extension("db.part");
    let mut file = tokio::fs::File::create(&tmp)
        .await
        .map_err(|e| CommandError::Io(e.to_string()))?;

    let mut received: u64 = 0;
    let mut last_pct: i64 = -1;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| CommandError::Http(e.to_string()))?;
        file.write_all(&chunk).await.map_err(|e| CommandError::Io(e.to_string()))?;
        received += chunk.len() as u64;
        if total > 0 {
            let pct = (received as f64 / total as f64 * 100.0).round() as i64;
            if pct != last_pct {
                last_pct = pct;
                let _ = app.emit("download-progress", pct);
            }
        }
    }
    file.flush().await.map_err(|e| CommandError::Io(e.to_string()))?;
    drop(file);
    tokio::fs::rename(&tmp, path)
        .await
        .map_err(|e| CommandError::Io(e.to_string()))?;
    Ok(())
}

#[tauri::command]
async fn prepare_database(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    let path = db_path(&app)?;

    if !path.exists() {
        download_db(&app, &path).await?;
    } else {
        let old = Connection::open(&path)?;
        let version = db::user_version(&old)?;
        if version < db::CURRENT_DB_VERSION {
            let backup = db::backup_favorites(&old)?;
            drop(old);
            download_db(&app, &path).await?;
            let mut fresh = Connection::open(&path)?;
            db::restore_favorites(&mut fresh, &backup)?;
            drop(fresh);
        } else {
            drop(old);
        }
    }

    let conn = Connection::open(&path)?;
    if db::user_version(&conn)? < db::CURRENT_DB_VERSION {
        db::set_user_version(&conn, db::CURRENT_DB_VERSION)?;
    }
    *state.conn.lock().unwrap() = Some(conn);
    Ok(())
}

#[tauri::command]
fn get_sentence_examples(state: State<AppState>, limit: i64) -> CmdResult<db::ItemList> {
    with_conn(&state, |c| Ok(db::ItemList { items: db::get_sentence_examples(c, limit)? }))
}

#[tauri::command]
fn get_word_favorites(state: State<AppState>, kind: String, limit: i64, page: i64) -> CmdResult<db::Paged> {
    with_conn(&state, |c| db::get_word_favorites(c, &kind, limit, page))
}

#[tauri::command]
fn get_sentence_favorites(state: State<AppState>, limit: i64, page: i64) -> CmdResult<db::Paged> {
    with_conn(&state, |c| db::get_sentence_favorites(c, limit, page))
}

#[tauri::command]
fn search_sentences(state: State<AppState>, word: String, limit: i64, page: i64) -> CmdResult<db::Paged> {
    with_conn(&state, |c| db::search_sentences(c, &word, limit, page))
}

#[tauri::command]
fn search_words(state: State<AppState>, kind: String, word: String, limit: i64, page: i64) -> CmdResult<db::Paged> {
    with_conn(&state, |c| db::search_words(c, &kind, &word, limit, page))
}

#[tauri::command]
fn save_sentence(state: State<AppState>, noun: String, verb: String) -> CmdResult<()> {
    with_conn(&state, |c| db::save_sentence(c, &noun, &verb))
}

#[tauri::command]
fn delete_sentence(state: State<AppState>, noun: String, verb: String) -> CmdResult<()> {
    with_conn(&state, |c| db::delete_sentence(c, &noun, &verb))
}

#[tauri::command]
fn save_word(state: State<AppState>, kind: String, word: String) -> CmdResult<()> {
    with_conn(&state, |c| db::save_word(c, &kind, &word))
}

#[tauri::command]
fn delete_word(state: State<AppState>, kind: String, word: String) -> CmdResult<()> {
    with_conn(&state, |c| db::delete_word(c, &kind, &word))
}

#[tauri::command]
fn generate_random_by_favorites(state: State<AppState>, limit: i64) -> CmdResult<db::ItemList> {
    with_conn(&state, |c| Ok(db::ItemList { items: db::generate_random_by_favorites(c, limit)? }))
}

#[tauri::command]
fn generate_with_word_by_favorites(
    state: State<AppState>,
    fixed_table: String,
    target_table: String,
    fixed_word: String,
    limit: i64,
    page: i64,
) -> CmdResult<db::Paged> {
    with_conn(&state, |c| {
        db::generate_with_word_by_favorites(c, &fixed_table, &target_table, &fixed_word, limit, page)
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            prepare_database,
            get_sentence_examples,
            get_word_favorites,
            get_sentence_favorites,
            search_sentences,
            search_words,
            save_sentence,
            delete_sentence,
            save_word,
            delete_word,
            generate_random_by_favorites,
            generate_with_word_by_favorites,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
