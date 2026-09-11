use parking_lot::RwLock;
use std::{
    collections::HashMap,
    fmt::Display,
    path::{Path, PathBuf},
    sync::Arc,
};
use uuid::Uuid;

// Fixed namespaces, so the same path always yields the same id, in this run and
// the next. The library is a projection of the filesystem, so an entity's
// identity is its path.
const PUBLICATION_UUID_NAMESPACE: Uuid = Uuid::from_u128(0x982d_adfe_87a8_484_18fa_aff834aa12d);
const COLLECTION_UUID_NAMESPACE: Uuid = Uuid::from_u128(0x873e_b87a_6b72_483_83af_178dcaf312d);

#[derive(Default, Debug, Clone, serde::Serialize, serde::Deserialize, Hash, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PublicationId(Uuid);

impl PublicationId {
    pub fn from_path(path: &Path) -> Self {
        Self(Uuid::new_v5(
            &PUBLICATION_UUID_NAMESPACE,
            normalize_path_for_id(path).to_string_lossy().as_bytes(),
        ))
    }
}

#[derive(Default, Debug, Clone, serde::Serialize, serde::Deserialize, Hash, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CollectionId(Uuid);

impl CollectionId {
    pub fn from_path(path: &Path) -> Self {
        Self(Uuid::new_v5(
            &COLLECTION_UUID_NAMESPACE,
            normalize_path_for_id(path).to_string_lossy().as_bytes(),
        ))
    }
}

fn normalize_path_for_id(path: &Path) -> PathBuf {
    path.components().collect()
}

#[derive(Default, Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedMetadata {
    pub title: String,
    pub authors: String,
    pub publisher: String,
    pub year: i32,
}

#[derive(Default, Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Publication {
    pub name: String,
    #[serde(skip)]
    pub path: PathBuf,
    pub metadata_file_extension: String,
    pub metadata_source: String,
    pub metadata: Option<ParsedMetadata>,
    pub reference_preview: Option<String>,
    pub available_content_file_extensions: Vec<String>,
}

#[derive(Default, Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub name: String,
    #[serde(skip)]
    pub path: PathBuf,
    pub child_publication_ids: Vec<PublicationId>,
    pub child_collection_ids: Vec<CollectionId>,
}

#[derive(Default, Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryState {
    pub root_collection_name: String,
    #[serde(skip)]
    pub root_collection_path: PathBuf,
    pub root_collection_id: CollectionId,
    pub root_child_publication_ids: Vec<PublicationId>,
    pub root_child_collection_ids: Vec<CollectionId>,
    pub collections: HashMap<CollectionId, Collection>,
    pub publications: HashMap<PublicationId, Publication>,
}

#[derive(Clone)]
pub struct LibraryStore {
    state: Arc<RwLock<LibraryState>>,
    publication_parents: Arc<RwLock<HashMap<PublicationId, CollectionId>>>,
    collection_parents: Arc<RwLock<HashMap<CollectionId, CollectionId>>>,
}

#[derive(Debug)]
pub enum Error {
    PublicationDoesntExist,
    PublicationAlreadyExists,
    CollectionDoesntExist,
    CollectionAlreadyExists,
}

impl Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self)
    }
}

// Thread safe wrapper around the Library state that ensures publications and
// collections are always in sync
impl LibraryStore {
    pub fn new(root_collection_name: String, root_collection_path: PathBuf) -> Self {
        let state = LibraryState {
            root_collection_name,
            root_collection_id: CollectionId::from_path(&root_collection_path),
            root_collection_path,
            root_child_publication_ids: Vec::new(),
            root_child_collection_ids: Vec::new(),
            collections: HashMap::new(),
            publications: HashMap::new(),
        };

        Self {
            state: Arc::new(RwLock::new(state)),
            publication_parents: Arc::new(RwLock::new(HashMap::new())),
            collection_parents: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn get_state(&self) -> LibraryState {
        self.state.read().clone()
    }

    pub fn set_state(&self, state: LibraryState) {
        let mut publication_parents = HashMap::new();
        let mut collection_parents = HashMap::new();

        for publication_id in &state.root_child_publication_ids {
            publication_parents.insert(publication_id.clone(), state.root_collection_id.clone());
        }
        for collection_id in &state.root_child_collection_ids {
            collection_parents.insert(collection_id.clone(), state.root_collection_id.clone());
        }
        for (collection_id, collection) in &state.collections {
            for publication_id in &collection.child_publication_ids {
                publication_parents.insert(publication_id.clone(), collection_id.clone());
            }
            for child_collection_id in &collection.child_collection_ids {
                collection_parents.insert(child_collection_id.clone(), collection_id.clone());
            }
        }

        *self.state.write() = state;
        *self.publication_parents.write() = publication_parents;
        *self.collection_parents.write() = collection_parents;
    }

    pub fn get_publication(&self, publication_id: PublicationId) -> Result<Publication, Error> {
        self.state
            .read()
            .publications
            .get(&publication_id)
            .cloned()
            .ok_or(Error::PublicationDoesntExist)
    }

    pub fn add_publication(
        &self,
        publication_id: PublicationId,
        collection_id: CollectionId,
        publication: Publication,
    ) -> Result<(), Error> {
        let mut state = self.state.write();

        if state.publications.contains_key(&publication_id) {
            return Err(Error::PublicationAlreadyExists);
        }

        if collection_id == state.root_collection_id {
            state
                .root_child_publication_ids
                .push(publication_id.clone());
        } else if let Some(collection) = state.collections.get_mut(&collection_id) {
            collection
                .child_publication_ids
                .push(publication_id.clone());
        } else {
            return Err(Error::CollectionDoesntExist);
        }

        state
            .publications
            .insert(publication_id.clone(), publication);
        self.publication_parents
            .write()
            .insert(publication_id, collection_id);

        Ok(())
    }

    pub fn update_publication(
        &self,
        publication_id: PublicationId,
        publication: Publication,
    ) -> Result<(), Error> {
        let mut state = self.state.write();

        if !state.publications.contains_key(&publication_id) {
            return Err(Error::PublicationDoesntExist);
        }

        state.publications.insert(publication_id, publication);

        Ok(())
    }

    pub fn remove_publication(&self, publication_id: PublicationId) -> Result<(), Error> {
        let mut state = self.state.write();

        if state.publications.remove(&publication_id).is_none() {
            return Err(Error::PublicationDoesntExist);
        }

        let parent_collection_id = self.publication_parents.write().remove(&publication_id);
        if let Some(parent_collection_id) = parent_collection_id {
            if parent_collection_id == state.root_collection_id {
                state
                    .root_child_publication_ids
                    .retain(|id| *id != publication_id);
            } else if let Some(parent) = state.collections.get_mut(&parent_collection_id) {
                parent
                    .child_publication_ids
                    .retain(|id| *id != publication_id);
            }
        }

        Ok(())
    }

    pub fn get_collection(&self, collection_id: CollectionId) -> Result<Collection, Error> {
        let state = self.state.read();

        if collection_id == state.root_collection_id {
            return Ok(Collection {
                name: state.root_collection_name.clone(),
                path: state.root_collection_path.clone(),
                child_publication_ids: state.root_child_publication_ids.clone(),
                child_collection_ids: state.root_child_collection_ids.clone(),
            });
        }

        state
            .collections
            .get(&collection_id)
            .cloned()
            .ok_or(Error::CollectionDoesntExist)
    }

    pub fn add_collection(
        &self,
        collection_id: CollectionId,
        parentc_collection_id: CollectionId,
        collection: Collection,
    ) -> Result<(), Error> {
        let mut state = self.state.write();

        if collection_id == state.root_collection_id
            || state.collections.contains_key(&collection_id)
        {
            return Err(Error::CollectionAlreadyExists);
        }

        if parentc_collection_id == state.root_collection_id {
            state.root_child_collection_ids.push(collection_id.clone());
        } else if let Some(parent) = state.collections.get_mut(&parentc_collection_id) {
            parent.child_collection_ids.push(collection_id.clone());
        } else {
            return Err(Error::CollectionDoesntExist);
        }

        state.collections.insert(
            collection_id.clone(),
            Collection {
                name: collection.name,
                path: collection.path,
                child_publication_ids: Vec::new(),
                child_collection_ids: Vec::new(),
            },
        );
        self.collection_parents
            .write()
            .insert(collection_id, parentc_collection_id);

        Ok(())
    }

    pub fn update_collection(
        &self,
        collection_id: CollectionId,
        collection: Collection,
    ) -> Result<(), Error> {
        let mut state = self.state.write();

        if collection_id == state.root_collection_id {
            state.root_collection_name = collection.name;
            state.root_collection_path = collection.path;
            return Ok(());
        }

        let existing = state
            .collections
            .get_mut(&collection_id)
            .ok_or(Error::CollectionDoesntExist)?;
        existing.name = collection.name;
        existing.path = collection.path;

        Ok(())
    }

    pub fn remove_collection(&self, collection_id: CollectionId) -> Result<(), Error> {
        let mut state = self.state.write();

        if collection_id == state.root_collection_id
            || !state.collections.contains_key(&collection_id)
        {
            return Err(Error::CollectionDoesntExist);
        }

        let mut publication_parents = self.publication_parents.write();
        let mut collection_parents = self.collection_parents.write();

        remove_collection_impl(
            &mut state,
            &mut publication_parents,
            &mut collection_parents,
            collection_id,
        );

        Ok(())
    }

    pub fn replace_subtree(
        &self,
        parent_collection_id: CollectionId,
        subtree: LibraryState,
    ) -> Result<(), Error> {
        let mut state = self.state.write();

        if subtree.root_collection_id == state.root_collection_id {
            return Err(Error::CollectionAlreadyExists);
        }
        if parent_collection_id != state.root_collection_id
            && !state.collections.contains_key(&parent_collection_id)
        {
            return Err(Error::CollectionDoesntExist);
        }

        let mut publication_parents = self.publication_parents.write();
        let mut collection_parents = self.collection_parents.write();

        remove_collection_impl(
            &mut state,
            &mut publication_parents,
            &mut collection_parents,
            subtree.root_collection_id.clone(),
        );

        for (collection_id, collection) in &subtree.collections {
            for publication_id in &collection.child_publication_ids {
                publication_parents.insert(publication_id.clone(), collection_id.clone());
            }
            for child_collection_id in &collection.child_collection_ids {
                collection_parents.insert(child_collection_id.clone(), collection_id.clone());
            }
        }
        for publication_id in &subtree.root_child_publication_ids {
            publication_parents.insert(publication_id.clone(), subtree.root_collection_id.clone());
        }
        for child_collection_id in &subtree.root_child_collection_ids {
            collection_parents.insert(child_collection_id.clone(), subtree.root_collection_id.clone());
        }

        state.collections.extend(subtree.collections);
        state.publications.extend(subtree.publications);
        state.collections.insert(
            subtree.root_collection_id.clone(),
            Collection {
                name: subtree.root_collection_name,
                path: subtree.root_collection_path,
                child_publication_ids: subtree.root_child_publication_ids,
                child_collection_ids: subtree.root_child_collection_ids,
            },
        );

        if parent_collection_id == state.root_collection_id {
            state
                .root_child_collection_ids
                .push(subtree.root_collection_id.clone());
        } else if let Some(parent) = state.collections.get_mut(&parent_collection_id) {
            parent
                .child_collection_ids
                .push(subtree.root_collection_id.clone());
        }
        collection_parents.insert(subtree.root_collection_id, parent_collection_id);

        Ok(())
    }
}

fn remove_collection_impl(
    state: &mut LibraryState,
    publication_parents: &mut HashMap<PublicationId, CollectionId>,
    collection_parents: &mut HashMap<CollectionId, CollectionId>,
    collection_id: CollectionId,
) {
    if let Some(parent_collection_id) = collection_parents.remove(&collection_id) {
        if parent_collection_id == state.root_collection_id {
            state
                .root_child_collection_ids
                .retain(|id| *id != collection_id);
        } else if let Some(parent) = state.collections.get_mut(&parent_collection_id) {
            parent
                .child_collection_ids
                .retain(|id| *id != collection_id);
        }
    }

    let mut pending = vec![collection_id];
    while let Some(id) = pending.pop() {
        let Some(removed) = state.collections.remove(&id) else {
            continue;
        };
        collection_parents.remove(&id);

        for publication_id in removed.child_publication_ids {
            state.publications.remove(&publication_id);
            publication_parents.remove(&publication_id);
        }
        pending.extend(removed.child_collection_ids);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn publication_path_for(name: &str) -> PathBuf {
        PathBuf::from("/library").join(format!("{}.opf", name))
    }

    fn collection_path_for(name: &str) -> PathBuf {
        PathBuf::from("/library").join(name)
    }

    /// Ids are derived from the path, so a test entity and its id are both
    /// keyed on the same name.
    fn publication_id_for(name: &str) -> PublicationId {
        PublicationId::from_path(&publication_path_for(name))
    }

    fn collection_id_for(name: &str) -> CollectionId {
        CollectionId::from_path(&collection_path_for(name))
    }

    fn new_publication(name: &str) -> Publication {
        Publication {
            name: name.to_string(),
            path: publication_path_for(name),
            metadata_file_extension: "opf".to_string(),
            metadata_source: "embedded".to_string(),
            metadata: None,
            reference_preview: None,
            available_content_file_extensions: vec!["epub".to_string()],
        }
    }

    fn new_collection(name: &str) -> Collection {
        Collection {
            name: name.to_string(),
            path: collection_path_for(name),
            child_publication_ids: Vec::new(),
            child_collection_ids: Vec::new(),
        }
    }

    #[test]
    fn set_state_replaces_state_and_rebuilds_indices() {
        let store = LibraryStore::new("Library".to_string(), PathBuf::from("/library"));
        let root_id = store.get_state().root_collection_id;

        let collection_id = collection_id_for("Sci-Fi");
        let publication_id = publication_id_for("Dune");

        let mut collections = HashMap::new();
        collections.insert(
            collection_id.clone(),
            Collection {
                name: "Sci-Fi".to_string(),
                path: PathBuf::from("/library/Sci-Fi"),
                child_publication_ids: vec![publication_id.clone()],
                child_collection_ids: Vec::new(),
            },
        );

        let mut publications = HashMap::new();
        publications.insert(publication_id.clone(), new_publication("Dune"));

        let new_state = LibraryState {
            root_collection_name: "Library".to_string(),
            root_collection_path: PathBuf::from("/library"),
            root_collection_id: root_id.clone(),
            root_child_publication_ids: Vec::new(),
            root_child_collection_ids: vec![collection_id.clone()],
            collections,
            publications,
        };

        store.set_state(new_state);

        assert!(store.get_collection(collection_id.clone()).is_ok());
        assert!(store.get_publication(publication_id.clone()).is_ok());

        store.remove_publication(publication_id.clone()).unwrap();
        let collection = store.get_collection(collection_id).unwrap();
        assert!(collection.child_publication_ids.is_empty());
    }

    #[test]
    fn ids_are_derived_from_the_path() {
        assert_eq!(
            PublicationId::from_path(Path::new("/library/sub/paper.bib")),
            PublicationId::from_path(Path::new("/library/sub/paper.bib"))
        );
        assert_ne!(
            PublicationId::from_path(Path::new("/library/sub/paper.bib")),
            PublicationId::from_path(Path::new("/library/paper.bib"))
        );
        assert_ne!(
            CollectionId::from_path(Path::new("/library/sub")),
            CollectionId::from_path(Path::new("/library/other"))
        );

        let store = LibraryStore::new("Library".to_string(), PathBuf::from("/library"));
        assert_eq!(
            store.get_state().root_collection_id,
            CollectionId::from_path(Path::new("/library"))
        );
    }

    //
    // Publications
    //

    #[test]
    fn add_and_get_publication_at_root() {
        let store = LibraryStore::new("Library".to_string(), PathBuf::from("/library"));
        let root_id = store.get_state().root_collection_id;
        let pub_id = publication_id_for("Dune");

        store
            .add_publication(pub_id.clone(), root_id.clone(), new_publication("Dune"))
            .unwrap();

        let fetched = store.get_publication(pub_id.clone()).unwrap();
        assert_eq!(fetched.name, "Dune");

        let root = store.get_collection(root_id).unwrap();
        assert_eq!(root.child_publication_ids, vec![pub_id]);
    }

    #[test]
    fn add_publication_into_nested_collection() {
        let store = LibraryStore::new("Library".to_string(), PathBuf::from("/library"));
        let root_id = store.get_state().root_collection_id;
        let collection_id = collection_id_for("Sci-Fi");
        store
            .add_collection(
                collection_id.clone(),
                root_id.clone(),
                new_collection("Sci-Fi"),
            )
            .unwrap();

        let pub_id = publication_id_for("Dune");
        store
            .add_publication(
                pub_id.clone(),
                collection_id.clone(),
                new_publication("Dune"),
            )
            .unwrap();

        let collection = store.get_collection(collection_id).unwrap();
        assert_eq!(collection.child_publication_ids, vec![pub_id.clone()]);

        // Root itself should be unaffected.
        let root = store.get_collection(root_id).unwrap();
        assert!(root.child_publication_ids.is_empty());
    }

    #[test]
    fn add_publication_to_missing_collection_errors() {
        let store = LibraryStore::new("Library".to_string(), PathBuf::from("/library"));
        let pub_id = publication_id_for("Dune");
        let missing_collection = collection_id_for("Missing");

        let result = store.add_publication(pub_id, missing_collection, new_publication("Dune"));
        assert!(matches!(result, Err(Error::CollectionDoesntExist)));
    }

    #[test]
    fn add_duplicate_publication_errors() {
        let store = LibraryStore::new("Library".to_string(), PathBuf::from("/library"));
        let root_id = store.get_state().root_collection_id;
        let pub_id = publication_id_for("Dune");

        store
            .add_publication(pub_id.clone(), root_id.clone(), new_publication("Dune"))
            .unwrap();

        let result = store.add_publication(pub_id, root_id, new_publication("Dune 2"));
        assert!(matches!(result, Err(Error::PublicationAlreadyExists)));
    }

    #[test]
    fn get_missing_publication_errors() {
        let store = LibraryStore::new("Library".to_string(), PathBuf::from("/library"));
        let result = store.get_publication(publication_id_for("Missing"));
        assert!(matches!(result, Err(Error::PublicationDoesntExist)));
    }

    #[test]
    fn update_publication_replaces_contents() {
        let store = LibraryStore::new("Library".to_string(), PathBuf::from("/library"));
        let root_id = store.get_state().root_collection_id;
        let pub_id = publication_id_for("Dune");

        store
            .add_publication(pub_id.clone(), root_id, new_publication("Dune"))
            .unwrap();

        store
            .update_publication(pub_id.clone(), new_publication("Dune: Messiah"))
            .unwrap();

        let fetched = store.get_publication(pub_id).unwrap();
        assert_eq!(fetched.name, "Dune: Messiah");
    }

    #[test]
    fn update_missing_publication_errors() {
        let store = LibraryStore::new("Library".to_string(), PathBuf::from("/library"));
        let result =
            store.update_publication(publication_id_for("Missing"), new_publication("Dune"));
        assert!(matches!(result, Err(Error::PublicationDoesntExist)));
    }

    #[test]
    fn remove_publication_detaches_from_parent() {
        let store = LibraryStore::new("Library".to_string(), PathBuf::from("/library"));
        let root_id = store.get_state().root_collection_id;
        let pub_id = publication_id_for("Dune");

        store
            .add_publication(pub_id.clone(), root_id.clone(), new_publication("Dune"))
            .unwrap();
        store.remove_publication(pub_id.clone()).unwrap();

        assert!(matches!(
            store.get_publication(pub_id),
            Err(Error::PublicationDoesntExist)
        ));
        assert!(store
            .get_collection(root_id)
            .unwrap()
            .child_publication_ids
            .is_empty());
    }

    #[test]
    fn remove_missing_publication_errors() {
        let store = LibraryStore::new("Library".to_string(), PathBuf::from("/library"));
        let result = store.remove_publication(publication_id_for("Missing"));
        assert!(matches!(result, Err(Error::PublicationDoesntExist)));
    }

    //
    // Collections
    //

    #[test]
    fn get_root_collection() {
        let store = LibraryStore::new("Library".to_string(), PathBuf::from("/library"));
        let root_id = store.get_state().root_collection_id;

        let root = store.get_collection(root_id).unwrap();
        assert_eq!(root.name, "Library");
    }

    #[test]
    fn get_missing_collection_errors() {
        let store = LibraryStore::new("Library".to_string(), PathBuf::from("/library"));
        let result = store.get_collection(collection_id_for("Missing"));
        assert!(matches!(result, Err(Error::CollectionDoesntExist)));
    }

    #[test]
    fn add_collection_under_root_registers_under_root() {
        let store = LibraryStore::new("Library".to_string(), PathBuf::from("/library"));
        let root_id = store.get_state().root_collection_id;
        let collection_id = collection_id_for("Sci-Fi");

        store
            .add_collection(
                collection_id.clone(),
                root_id.clone(),
                new_collection("Sci-Fi"),
            )
            .unwrap();

        let root = store.get_collection(root_id).unwrap();
        assert_eq!(root.child_collection_ids, vec![collection_id.clone()]);
        assert_eq!(store.get_collection(collection_id).unwrap().name, "Sci-Fi");
    }

    #[test]
    fn add_nested_collection() {
        let store = LibraryStore::new("Library".to_string(), PathBuf::from("/library"));
        let root_id = store.get_state().root_collection_id;
        let parent_id = collection_id_for("Fiction");
        store
            .add_collection(
                parent_id.clone(),
                root_id.clone(),
                new_collection("Fiction"),
            )
            .unwrap();

        let child_id = collection_id_for("Sci-Fi");
        store
            .add_collection(
                child_id.clone(),
                parent_id.clone(),
                new_collection("Sci-Fi"),
            )
            .unwrap();

        let parent = store.get_collection(parent_id).unwrap();
        assert_eq!(parent.child_collection_ids, vec![child_id.clone()]);
        assert_eq!(store.get_collection(child_id).unwrap().name, "Sci-Fi");
    }

    #[test]
    fn add_collection_to_missing_parent_errors() {
        let store = LibraryStore::new("Library".to_string(), PathBuf::from("/library"));
        let result = store.add_collection(
            collection_id_for("Sci-Fi"),
            collection_id_for("Missing"),
            new_collection("Sci-Fi"),
        );
        assert!(matches!(result, Err(Error::CollectionDoesntExist)));
    }

    #[test]
    fn add_duplicate_nested_collection_errors() {
        let store = LibraryStore::new("Library".to_string(), PathBuf::from("/library"));
        let root_id = store.get_state().root_collection_id;
        let collection_id = collection_id_for("Sci-Fi");

        store
            .add_collection(
                collection_id.clone(),
                root_id.clone(),
                new_collection("Sci-Fi"),
            )
            .unwrap();

        let result = store.add_collection(collection_id, root_id, new_collection("Dup"));
        assert!(matches!(result, Err(Error::CollectionAlreadyExists)));
    }

    #[test]
    fn update_root_collection_name() {
        let store = LibraryStore::new("Library".to_string(), PathBuf::from("/library"));
        let root_id = store.get_state().root_collection_id;

        store
            .update_collection(root_id.clone(), new_collection("My Library"))
            .unwrap();

        assert_eq!(store.get_collection(root_id).unwrap().name, "My Library");
    }

    #[test]
    fn update_collection_ignores_child_id_tampering() {
        let store = LibraryStore::new("Library".to_string(), PathBuf::from("/library"));
        let root_id = store.get_state().root_collection_id;
        let collection_id = collection_id_for("Sci-Fi");
        store
            .add_collection(
                collection_id.clone(),
                root_id.clone(),
                new_collection("Sci-Fi"),
            )
            .unwrap();

        // Attempting to smuggle in fabricated child ids must not corrupt
        // the tree / parent indices.
        let mut tampered = new_collection("Sci-Fi Renamed");
        tampered.child_collection_ids = vec![root_id];
        store
            .update_collection(collection_id.clone(), tampered)
            .unwrap();

        let updated = store.get_collection(collection_id).unwrap();
        assert_eq!(updated.name, "Sci-Fi Renamed");
        assert!(updated.child_collection_ids.is_empty());
    }

    #[test]
    fn update_missing_collection_errors() {
        let store = LibraryStore::new("Library".to_string(), PathBuf::from("/library"));
        let result =
            store.update_collection(collection_id_for("Missing"), new_collection("Sci-Fi"));
        assert!(matches!(result, Err(Error::CollectionDoesntExist)));
    }

    #[test]
    fn remove_collection_detaches_from_parent() {
        let store = LibraryStore::new("Library".to_string(), PathBuf::from("/library"));
        let root_id = store.get_state().root_collection_id;
        let collection_id = collection_id_for("Sci-Fi");

        store
            .add_collection(
                collection_id.clone(),
                root_id.clone(),
                new_collection("Sci-Fi"),
            )
            .unwrap();
        store.remove_collection(collection_id.clone()).unwrap();

        assert!(matches!(
            store.get_collection(collection_id),
            Err(Error::CollectionDoesntExist)
        ));
        assert!(store
            .get_collection(root_id)
            .unwrap()
            .child_collection_ids
            .is_empty());
    }

    #[test]
    fn remove_collection_cascades_to_descendants() {
        let store = LibraryStore::new("Library".to_string(), PathBuf::from("/library"));
        let root_id = store.get_state().root_collection_id;

        let parent_id = collection_id_for("Fiction");
        store
            .add_collection(
                parent_id.clone(),
                root_id.clone(),
                new_collection("Fiction"),
            )
            .unwrap();

        let child_id = collection_id_for("Sci-Fi");
        store
            .add_collection(
                child_id.clone(),
                parent_id.clone(),
                new_collection("Sci-Fi"),
            )
            .unwrap();

        let pub_in_parent = publication_id_for("A");
        store
            .add_publication(
                pub_in_parent.clone(),
                parent_id.clone(),
                new_publication("A"),
            )
            .unwrap();

        let pub_in_child = publication_id_for("B");
        store
            .add_publication(pub_in_child.clone(), child_id.clone(), new_publication("B"))
            .unwrap();

        store.remove_collection(parent_id.clone()).unwrap();

        assert!(matches!(
            store.get_collection(parent_id),
            Err(Error::CollectionDoesntExist)
        ));
        assert!(matches!(
            store.get_collection(child_id),
            Err(Error::CollectionDoesntExist)
        ));
        assert!(matches!(
            store.get_publication(pub_in_parent),
            Err(Error::PublicationDoesntExist)
        ));
        assert!(matches!(
            store.get_publication(pub_in_child),
            Err(Error::PublicationDoesntExist)
        ));
    }

    #[test]
    fn remove_root_collection_errors() {
        let store = LibraryStore::new("Library".to_string(), PathBuf::from("/library"));
        let root_id = store.get_state().root_collection_id;
        let result = store.remove_collection(root_id);
        assert!(matches!(result, Err(Error::CollectionDoesntExist)));
    }

    #[test]
    fn remove_missing_collection_errors() {
        let store = LibraryStore::new("Library".to_string(), PathBuf::from("/library"));
        let result = store.remove_collection(collection_id_for("Missing"));
        assert!(matches!(result, Err(Error::CollectionDoesntExist)));
    }
    fn new_subtree(name: &str, child_publication_names: &[&str]) -> LibraryState {
        LibraryState {
            root_collection_name: name.to_string(),
            root_collection_path: collection_path_for(name),
            root_collection_id: collection_id_for(name),
            root_child_publication_ids: child_publication_names
                .iter()
                .map(|n| publication_id_for(n))
                .collect(),
            root_child_collection_ids: Vec::new(),
            collections: HashMap::new(),
            publications: child_publication_names
                .iter()
                .map(|n| (publication_id_for(n), new_publication(n)))
                .collect(),
        }
    }

    #[test]
    fn ids_ignore_how_the_same_path_is_spelled() {
        assert_eq!(
            CollectionId::from_path(Path::new("/library/papers/")),
            CollectionId::from_path(Path::new("/library/./papers"))
        );
        assert_eq!(
            PublicationId::from_path(Path::new("/library//papers/a.opf")),
            PublicationId::from_path(Path::new("/library/papers/a.opf"))
        );
    }

    #[test]
    fn replace_subtree_grafts_a_new_collection_under_the_root() {
        let store = LibraryStore::new("Library".to_string(), PathBuf::from("/library"));
        let root_id = store.get_state().root_collection_id;

        store
            .replace_subtree(root_id.clone(), new_subtree("papers", &["a", "b"]))
            .unwrap();

        let state = store.get_state();
        assert_eq!(state.root_child_collection_ids, vec![collection_id_for("papers")]);
        assert_eq!(state.publications.len(), 2);

        let grafted = store.get_collection(collection_id_for("papers")).unwrap();
        assert_eq!(grafted.name, "papers".to_string());
        assert_eq!(grafted.child_publication_ids.len(), 2);

        // The parent index has to know the grafted publications, or removing one
        // would leave a dangling child id behind.
        store.remove_publication(publication_id_for("a")).unwrap();
        assert_eq!(
            store
                .get_collection(collection_id_for("papers"))
                .unwrap()
                .child_publication_ids,
            vec![publication_id_for("b")]
        );
    }

    #[test]
    fn replace_subtree_drops_what_the_collection_held_before() {
        let store = LibraryStore::new("Library".to_string(), PathBuf::from("/library"));
        let root_id = store.get_state().root_collection_id;

        store
            .replace_subtree(root_id.clone(), new_subtree("papers", &["stale"]))
            .unwrap();
        store
            .replace_subtree(root_id.clone(), new_subtree("papers", &["fresh"]))
            .unwrap();

        let state = store.get_state();
        assert_eq!(state.root_child_collection_ids, vec![collection_id_for("papers")]);
        assert!(!state.publications.contains_key(&publication_id_for("stale")));
        assert!(state.publications.contains_key(&publication_id_for("fresh")));
        assert_eq!(state.publications.len(), 1);
    }

    #[test]
    fn replace_subtree_rejects_an_unknown_parent() {
        let store = LibraryStore::new("Library".to_string(), PathBuf::from("/library"));

        let result = store.replace_subtree(collection_id_for("nowhere"), new_subtree("papers", &[]));

        assert!(matches!(result, Err(Error::CollectionDoesntExist)));
    }
}
