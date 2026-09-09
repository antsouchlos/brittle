use std::{collections::HashMap, sync::Arc};

use parking_lot::RwLock;

#[derive(Debug, Default, Clone)]
pub struct ParsedMetadata {
    title: String,
    authors: String,
    publisher: String,
    year: i32,
}

#[derive(Debug, Default, Clone)]
pub struct MetadataPackage {
    source: String,
    file_extension: String,
    metadata: Option<ParsedMetadata>,
}

#[derive(Debug, Default, Clone)]
pub struct Publication {
    metadata: MetadataPackage,
    content_extensions: Vec<String>,
    parent_collection_path: String,
}

#[derive(Debug, Default, Clone)]
pub struct Collection {
    path: String,
    child_publications: Vec<String>,
    child_collections: Vec<String>,
}

#[derive(Debug, Default, Clone)]
pub struct LibraryState {
    collections: HashMap<String, Collection>,
    publications: HashMap<String, Publication>,
}

pub struct LibraryStore {
    state: Arc<RwLock<LibraryState>>,
}

pub enum Error {
    PublicationDoesntExist,
    PublicationAlreadyExists,
    CollectionDoesntExist,
    CollectionAlreadyExists,
}

impl LibraryStore {
    pub fn new() -> Self {
        Self {
            state: Arc::new(RwLock::new(LibraryState::default())),
        }
    }
}

// Thread safe wrapper around the Library state that ensures publications and
// collections are always in sync
impl LibraryStore {
    pub fn get_state(&self) -> LibraryState {
        (*self.state.read()).clone()
    }

    pub fn get_publication(&self, path_stem: String) -> Result<Publication, Error> {
        self.state
            .read()
            .publications
            .get(&path_stem)
            .cloned()
            .ok_or(Error::PublicationDoesntExist)
    }

    pub fn add_publication(
        &self,
        path_stem: String,
        data: Publication,
        collection_path: String,
    ) -> Result<(), Error> {
        let mut state = self.state.write();

        if state.publications.contains_key(&path_stem) {
            return Err(Error::PublicationAlreadyExists);
        }

        if !state.collections.contains_key(&path_stem) {
            return Err(Error::CollectionDoesntExist);
        }

        state.publications.insert(path_stem.clone(), data);

        state
            .collections
            .get_mut(&collection_path)
            .expect("This should exist, we previously checked")
            .child_publications
            .push(path_stem);

        Ok(())
    }

    pub fn update_publication(&self, path_stem: String, data: Publication) -> Result<(), Error> {
        let mut state = self.state.write();

        if !state.publications.contains_key(&path_stem) {
            return Err(Error::PublicationDoesntExist);
        }

        state
            .publications
            .insert(path_stem, data)
            .expect("This should exist, we checked previously");

        Ok(())
    }

    pub fn remove_publication(&self, path_stem: &String) -> Result<(), Error> {
        let mut state = self.state.write();

        if !state.publications.contains_key(path_stem) {
            return Err(Error::PublicationDoesntExist);
        }

        let publication = state
            .publications
            .remove(path_stem)
            .expect("This should exist, we checked previously");

        let child_publications = &mut state
            .collections
            .get_mut(&publication.parent_collection_path)
            .expect("`LibraryStore` should ensure this exists when the publication does as well")
            .child_publications;

        child_publications.remove(
            child_publications
                .iter()
                .position(|r| r == path_stem)
                .expect(
                    "`LibraryStore` should ensure this exists when the publication does as well",
                ),
        );

        Ok(())
    }

    pub fn get_collection(&self, path: &String) -> Result<Collection, Error> {
        self.state
            .read()
            .collections
            .get(path)
            .cloned()
            .ok_or(Error::CollectionDoesntExist)
    }

    fn add_collection(&self, path: String, data: Collection) -> Result<(), Error> {
        let mut state = self.state.write();

        if state.collections.contains_key(&path) {
            return Err(Error::CollectionAlreadyExists);
        }

        state.collections.insert(path, data);

        Ok(())
    }

    fn update_collection(&self, path: String, data: Collection) -> Result<(), Error> {
        let mut state = self.state.write();

        if !state.collections.contains_key(&path) {
            return Err(Error::CollectionDoesntExist);
        }

        state.collections.insert(path, data);

        Ok(())
    }

    fn remove_collection(&self, path: &String) -> Result<(), Error> {
        let state = self.state.write();

        if !state.collections.contains_key(path) {
            return Err(Error::CollectionDoesntExist);
        }

        let child_collections = &state
            .collections
            .get(path)
            .expect("This should exist, we checked previously")
            .child_collections;

        let child_publications = &state
            .collections
            .get(path)
            .expect("This should exist, we checked previously")
            .child_publications;

        for path in child_collections {
            self.remove_collection(&path)?;
        }

        for path_stem in child_publications {
            self.remove_publication(&path_stem)?;
        }

        Ok(())
    }
}
