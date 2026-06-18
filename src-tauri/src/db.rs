use rand::Rng;
use rusqlite::types::{Value, ValueRef};
use rusqlite::{params_from_iter, Connection};
use serde::Serialize;

pub const CURRENT_DB_VERSION: i64 = 8;
pub const DB_FILENAME: &str = "wo.db";
pub const DB_URL: &str = "https://db.wo.style/wo.db";

pub type Item = Vec<String>;

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error("不正な種別です: {0}")]
    InvalidType(String),
}

impl Serialize for DbError {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

type Result<T> = std::result::Result<T, DbError>;

#[derive(Serialize)]
pub struct Paged {
    pub items: Vec<Item>,
    pub page: i64,
    #[serde(rename = "hasNext")]
    pub has_next: bool,
}

#[derive(Serialize)]
pub struct ItemList {
    pub items: Vec<Item>,
}

fn value_to_string(v: ValueRef<'_>) -> String {
    match v {
        ValueRef::Null => String::new(),
        ValueRef::Integer(n) => n.to_string(),
        ValueRef::Real(f) => f.to_string(),
        ValueRef::Text(t) => String::from_utf8_lossy(t).into_owned(),
        ValueRef::Blob(_) => String::new(),
    }
}

fn query_rows(conn: &Connection, sql: &str, params: Vec<Value>) -> Result<Vec<Item>> {
    let mut stmt = conn.prepare(sql)?;
    let col_count = stmt.column_count();
    let rows = stmt.query_map(params_from_iter(params), |row| {
        let mut item = Vec::with_capacity(col_count);
        for i in 0..col_count {
            item.push(value_to_string(row.get_ref(i)?));
        }
        Ok(item)
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<Item>>>()?)
}

fn split_has_next(mut rows: Vec<Item>, limit: i64) -> (Vec<Item>, bool) {
    let has_next = rows.len() as i64 > limit;
    if has_next {
        rows.truncate(limit as usize);
    }
    (rows, has_next)
}

fn select_paged(
    conn: &Connection,
    base_sql: &str,
    mut params: Vec<Value>,
    page: i64,
    limit: i64,
) -> Result<(Vec<Item>, bool)> {
    let offset = page * limit;
    params.push(Value::Integer(limit + 1));
    params.push(Value::Integer(offset));
    let sql = format!("{base_sql} LIMIT ? OFFSET ?");
    let rows = query_rows(conn, &sql, params)?;
    Ok(split_has_next(rows, limit))
}

fn word_table(kind: &str) -> Result<&'static str> {
    match kind {
        "noun" => Ok("noun"),
        "verb" => Ok("verb"),
        other => Err(DbError::InvalidType(other.to_string())),
    }
}

pub fn get_sentence_examples(conn: &Connection, limit: i64) -> Result<Vec<Item>> {
    let max_id: i64 = conn.query_row("SELECT MAX(id) FROM verb_example", [], |r| r.get(0))?;
    if max_id <= 0 {
        return Ok(vec![]);
    }

    let want = limit.min(max_id) as usize;
    let mut rng = rand::thread_rng();
    let mut unique_ids: std::collections::HashSet<i64> = std::collections::HashSet::new();
    while unique_ids.len() < want {
        unique_ids.insert(rng.gen_range(1..=max_id));
    }
    let random_verb_ids: Vec<i64> = unique_ids.into_iter().collect();
    let placeholders = vec!["?"; random_verb_ids.len()].join(",");

    let sql = format!(
        "WITH target_pairs AS (
            SELECT verb_id, noun_id,
                   ROW_NUMBER() OVER(PARTITION BY verb_id ORDER BY RANDOM()) as rn
            FROM sentence_example
            WHERE verb_id IN ({placeholders})
        )
        SELECT ne.word, ve.word,
               EXISTS(SELECT 1 FROM noun WHERE word = ne.word),
               EXISTS(SELECT 1 FROM verb WHERE word = ve.word)
        FROM target_pairs tp
        JOIN noun_example ne ON tp.noun_id = ne.id
        JOIN verb_example ve ON tp.verb_id = ve.id
        WHERE tp.rn = 1"
    );
    let params: Vec<Value> = random_verb_ids.into_iter().map(Value::Integer).collect();
    query_rows(conn, &sql, params)
}

pub fn get_word_favorites(conn: &Connection, kind: &str, limit: i64, page: i64) -> Result<Paged> {
    let table = word_table(kind)?;
    let sql = format!("SELECT word FROM {table} ORDER BY ROWID DESC");
    let (items, has_next) = select_paged(conn, &sql, vec![], page, limit)?;
    Ok(Paged {
        items,
        page,
        has_next,
    })
}

pub fn get_sentence_favorites(conn: &Connection, limit: i64, page: i64) -> Result<Paged> {
    let (items, has_next) = select_paged(
        conn,
        "SELECT noun, verb FROM sentence ORDER BY ROWID DESC",
        vec![],
        page,
        limit,
    )?;
    Ok(Paged {
        items,
        page,
        has_next,
    })
}

pub fn search_sentences(conn: &Connection, word: &str, limit: i64, page: i64) -> Result<Paged> {
    let lim = if limit > 0 { limit } else { 20 };
    let pg = page;
    let like = format!("%{word}%");
    let need = (pg + 1) * lim + 1;
    let fetch = lim + 1;

    let sql = "
        SELECT noun, verb, nfav, vfav FROM (
            SELECT * FROM (
                SELECT ne.word AS noun, ve.word AS verb, se.count AS cnt,
                       se.noun_id AS nid, se.verb_id AS vid,
                       EXISTS(SELECT 1 FROM noun WHERE word = ne.word) AS nfav,
                       EXISTS(SELECT 1 FROM verb WHERE word = ve.word) AS vfav
                FROM sentence_example se
                JOIN noun_example ne ON se.noun_id = ne.id
                JOIN verb_example ve ON se.verb_id = ve.id
                WHERE se.noun_id IN (SELECT id FROM noun_example WHERE word LIKE ?)
                ORDER BY se.count DESC, se.noun_id, se.verb_id LIMIT ?
            )
            UNION
            SELECT * FROM (
                SELECT ne.word, ve.word, se.count, se.noun_id, se.verb_id,
                       EXISTS(SELECT 1 FROM noun WHERE word = ne.word),
                       EXISTS(SELECT 1 FROM verb WHERE word = ve.word)
                FROM sentence_example se
                JOIN noun_example ne ON se.noun_id = ne.id
                JOIN verb_example ve ON se.verb_id = ve.id
                WHERE se.verb_id IN (SELECT id FROM verb_example WHERE word LIKE ?)
                ORDER BY se.count DESC, se.noun_id, se.verb_id LIMIT ?
            )
        )
        ORDER BY cnt DESC, nid, vid LIMIT ? OFFSET ?";

    let params = vec![
        Value::Text(like.clone()),
        Value::Integer(need),
        Value::Text(like),
        Value::Integer(need),
        Value::Integer(fetch),
        Value::Integer(pg * lim),
    ];
    let rows = query_rows(conn, sql, params)?;
    let (items, has_next) = split_has_next(rows, lim);
    Ok(Paged {
        items,
        page: pg,
        has_next,
    })
}

pub fn search_words(
    conn: &Connection,
    kind: &str,
    word: &str,
    limit: i64,
    page: i64,
) -> Result<Paged> {
    let table = word_table(kind)?;
    let sql = format!("SELECT word FROM {table} WHERE word LIKE ? ORDER BY ROWID DESC");
    let (items, has_next) = select_paged(
        conn,
        &sql,
        vec![Value::Text(format!("%{word}%"))],
        page,
        limit,
    )?;
    Ok(Paged {
        items,
        page,
        has_next,
    })
}

pub fn save_sentence(conn: &Connection, noun: &str, verb: &str) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO sentence (noun, verb) VALUES (?, ?)",
        rusqlite::params![noun, verb],
    )?;
    Ok(())
}

pub fn delete_sentence(conn: &Connection, noun: &str, verb: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM sentence WHERE noun = ? AND verb = ?",
        rusqlite::params![noun, verb],
    )?;
    Ok(())
}

pub fn save_word(conn: &Connection, kind: &str, word: &str) -> Result<()> {
    let table = word_table(kind)?;
    conn.execute(
        &format!("INSERT OR IGNORE INTO {table} (word) VALUES (?)"),
        rusqlite::params![word],
    )?;
    Ok(())
}

pub fn delete_word(conn: &Connection, kind: &str, word: &str) -> Result<()> {
    let table = word_table(kind)?;
    conn.execute(
        &format!("DELETE FROM {table} WHERE word = ?"),
        rusqlite::params![word],
    )?;
    Ok(())
}

pub fn generate_random_by_favorites(conn: &Connection, limit: i64) -> Result<Vec<Item>> {
    let nouns = query_rows(
        conn,
        "SELECT word FROM noun ORDER BY RANDOM() LIMIT ?",
        vec![Value::Integer(limit)],
    )?;
    let verbs = query_rows(
        conn,
        "SELECT word FROM verb ORDER BY RANDOM() LIMIT ?",
        vec![Value::Integer(limit)],
    )?;
    mark_saved_sentences(conn, zip_pairs(nouns, verbs))
}

fn mark_saved_sentences(conn: &Connection, pairs: Vec<Item>) -> Result<Vec<Item>> {
    let mut stmt = conn.prepare("SELECT 1 FROM sentence WHERE noun = ? AND verb = ?")?;
    let mut out = Vec::with_capacity(pairs.len());
    for p in pairs {
        let fav = stmt.exists(rusqlite::params![p[0], p[1]])?;
        out.push(vec![
            p[0].clone(),
            p[1].clone(),
            if fav { "1" } else { "0" }.to_string(),
        ]);
    }
    Ok(out)
}

fn zip_pairs(nouns: Vec<Item>, verbs: Vec<Item>) -> Vec<Item> {
    nouns
        .into_iter()
        .zip(verbs)
        .map(|(n, v)| vec![n[0].clone(), v[0].clone()])
        .collect()
}

pub fn generate_with_word_by_favorites(
    conn: &Connection,
    fixed_table: &str,
    target_table: &str,
    fixed_word: &str,
    limit: i64,
    page: i64,
) -> Result<Paged> {
    let is_fixed_noun = fixed_table == "noun";
    let rotate = word_table(target_table)?;
    let projection = if is_fixed_noun {
        "?, word, EXISTS(SELECT 1 FROM sentence WHERE noun = ? AND verb = word)".to_string()
    } else {
        "word, ?, EXISTS(SELECT 1 FROM sentence WHERE noun = word AND verb = ?)".to_string()
    };
    let base_sql = format!("SELECT {projection} FROM {rotate}");
    let params = vec![
        Value::Text(fixed_word.to_string()),
        Value::Text(fixed_word.to_string()),
    ];
    let (items, has_next) = select_paged(conn, &base_sql, params, page, limit)?;
    Ok(Paged {
        items,
        page,
        has_next,
    })
}

pub struct FavoritesBackup {
    pub nouns: Vec<String>,
    pub verbs: Vec<String>,
    pub sentences: Vec<(String, String)>,
}

pub fn backup_favorites(conn: &Connection) -> Result<FavoritesBackup> {
    let nouns = query_rows(conn, "SELECT word FROM noun", vec![])?
        .into_iter()
        .map(|r| r[0].clone())
        .collect();
    let verbs = query_rows(conn, "SELECT word FROM verb", vec![])?
        .into_iter()
        .map(|r| r[0].clone())
        .collect();
    let sentences = query_rows(conn, "SELECT noun, verb FROM sentence", vec![])?
        .into_iter()
        .map(|r| (r[0].clone(), r[1].clone()))
        .collect();
    Ok(FavoritesBackup {
        nouns,
        verbs,
        sentences,
    })
}

pub fn restore_favorites(conn: &mut Connection, backup: &FavoritesBackup) -> Result<()> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM noun;", [])?;
    tx.execute("DELETE FROM verb;", [])?;
    tx.execute("DELETE FROM sentence;", [])?;
    {
        let mut stmt = tx.prepare("INSERT OR IGNORE INTO noun (word) VALUES (?)")?;
        for w in &backup.nouns {
            stmt.execute([w])?;
        }
        let mut stmt = tx.prepare("INSERT OR IGNORE INTO verb (word) VALUES (?)")?;
        for w in &backup.verbs {
            stmt.execute([w])?;
        }
        let mut stmt = tx.prepare("INSERT OR IGNORE INTO sentence (noun, verb) VALUES (?, ?)")?;
        for (n, v) in &backup.sentences {
            stmt.execute([n, v])?;
        }
    }
    tx.commit()?;
    Ok(())
}

pub fn user_version(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row("PRAGMA user_version", [], |r| r.get(0))?)
}

pub fn set_user_version(conn: &Connection, version: i64) -> Result<()> {
    conn.pragma_update(None, "user_version", version)?;
    Ok(())
}
