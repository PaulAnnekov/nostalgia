# Nostalgia

One-way sync (from local folders to cloud) of media items to Google Photos using unofficial API.

- uploads only files with [supported extensions](https://developers.google.com/photos/library/guides/upload-media#file-types-sizes)
- ignores zero-byte files
- each folder is traversed recursively
- saves already uploaded files to `nostalgia.json` file in album folder and ignores them on next execution
- concurrent upload (5 streams by default)
- cooldown mechanism and retries on upload failure

Run an app for the following directory:
```
.
├── 2015.01.16-25 Trip to Portugal
|   ├── IMG_20150118_153701.jpg
|   └── IMG_20150118_152755.jpg
└── 2015.11.24 Home Party
    ├── Videos
    |   ├── GOPR0001.MP4
    |   └── GOPR0010.MP4
    ├── IMG_20150118_153701.jpg
    └── IMG_20150118_152755.jpg
```

And you will get two albums in Google Photos:
```
2015.01.16-25 Trip to Portugal
  IMG_20150118_153701.jpg
  IMG_20150118_152755.jpg

2015.11.24 Home Party
  GOPR0001.MP4
  GOPR0010.MP4
  IMG_20150118_153701.jpg
  IMG_20150118_152755.jpg
```

## Why not...

- To save cloud file ID after upload and on re-sync list cloud files and compare their IDs with locally saved IDs  
  Because `.upload()` returns "file ID", while `album.fetchPhotoList()` returns a list of "album file ID"s. To get "album
  file ID" after upload you need to parse `album.fetchPhotoList()` response. Also it won't return you "album file ID" if
  uploaded file was already present in cloud before upload

- On re-sync to fetch album files and compare local with cloud by file title  
  Because `album.fetchPhotoList()` doesn't return file title. You need to make an additional request per file to get
  its info which will include `title`
