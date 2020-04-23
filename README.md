# Nostalgia

## Algorithm

- list all sub-folders
- for each sub-folder
    - recursively get a list of all files, filter out non-image/video
    - check whether album with folder name already exists
        - create if not
    - get a list of all media in an album
    - load a list of already synced files from nostalgia.json
    - compare ids from cloud and ids from json and prepare a list for upload
    - upload each file
        - update nostalgia.json with file and its cloud id

## Why not...

- To save cloud file ID after upload and on re-sync list cloud files and compare their IDs with locally saved IDs  
  Because `.upload()` returns "file ID", while `album.fetchPhotoList()` returns a list of "album file ID"s. To get "album
  file ID" after upload you need to parse `album.fetchPhotoList()` response. Also it won't return you "album file ID" if
  uploaded file was already present in cloud before upload

- On re-sync to fetch album files and compare local with cloud by file title  
  Because `album.fetchPhotoList()` doesn't return file title. You need to make an additional request per file to get
  its info which will include `title`
