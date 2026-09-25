//! stub
use super::ReadOptions;
use crate::error::{CreateError, Result};
use crate::model::Document;

pub fn read(_b: &str, _o: &ReadOptions) -> Result<Document> {
    Err(CreateError::Unsupported("html".into()))
}
