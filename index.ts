import fs from 'fs';
import path from 'path';
import { GPhotos } from 'upload-gphotos';
import { CookieJar, Cookie } from 'tough-cookie';
import config from './config.json';
import bunyan, { LogLevel } from 'bunyan';

const log = bunyan.createLogger({ 
    name: 'nostalgia',
    level: process.env.LOG_LEVEL as LogLevel || 'info' 
});

process.on('unhandledRejection', (err) => {
    log.error(err);
    process.exit(2);
}).on('uncaughtException', (err) => {
    log.error(err);
    process.exit(3);
});

class AlbumSettings {
    private readonly ALBUM_SETTINGS_FILE = 'nostalgia.json';
    private readonly path: string;
    synced: { [key: string]: {
        id: string
    } };

    constructor(source: string) {
        this.path = path.resolve(source, this.ALBUM_SETTINGS_FILE);
    }

    async loadSettings() {
        log.debug({ path: this.path }, 'loading local album settings');
        const contents = await fs.promises.readFile(this.path, { encoding: 'utf8', flag: 'a+' });
        const settings = contents ? JSON.parse(contents) : {};
        this.synced = settings.synced || {};
    }

    async updateSynced(name: string, id: string) {
        log.debug({ path: this.path }, 'updating local album settings');
        this.synced[name] = { id };
        await fs.promises.writeFile(this.path, JSON.stringify({
            synced: this.synced
        }));
    }
}

class OneWaySync {
    private readonly APP_NAME = 'Nostalgia';
    // https://developers.google.com/photos/library/guides/upload-media#file-types-sizes
    private readonly SUPPORTED_TYPES = ['BMP', 'GIF', 'HEIC', 'ICO', 'JPG', 'PNG', 'TIFF', 'WEBP', 'RAW', '3GP', '3G2', 
        'ASF', 'AVI', 'DIVX', 'M2T', 'M2TS', 'M4V', 'MKV', 'MMV', 'MOD', 'MOV', 'MP4', 'MPG', 'MTS', 'TOD', 'WMV'];
    private readonly gphotos: GPhotos;
    private readonly source: string;

    constructor (source: string) {
        if (!source) {
            throw new Error('nothing to sync');
        }
        this.source = source;
        this.gphotos = new GPhotos();
    }

    private async auth() {
        const jar = new CookieJar();
        config.cookies.forEach((cookie) => {
            jar.setCookieSync(
                new Cookie({
                    key: cookie.Name,
                    value: cookie.Value,
                    domain: cookie.Domain.replace(/^\./, ''),
                    path: cookie.Path,
                }),
                'https://photos.google.com',
                {
                    http: cookie.HttpOnly,
                    secure: cookie.Secure,
                    ignoreError: true,
                }
            );
        });
        this.gphotos.setCookieJar(jar);
        try {
            await this.gphotos.signin({
                username: '',
                password: '',
            });
        } catch (err) {
            log.error(`failed to login`);
            throw err;
        }
    }

    private generateFilename(realName: string) {
        return `(${this.APP_NAME} App) ${realName}`;
    }

    private async getDirectories(source: string) {
        const entities = await fs.promises.readdir(source, { withFileTypes: true });
        return entities.filter(entity => entity.isDirectory()).map(entity => entity.name);
    }
    
    private async getMediaFiles(source: string) {
        let files: string[] = [];
        const entities = await fs.promises.readdir(source, { withFileTypes: true });
        for (const entity of entities) {
            if (entity.isFile() && this.SUPPORTED_TYPES.includes(path.extname(entity.name).slice(1).toUpperCase())) {
                files.push(entity.name);
            } else if (entity.isDirectory()) {
                files = files.concat(await this.getMediaFiles(path.resolve(source, entity.name)));
            }
        }
        return files;
    }

    // private async fetchCloudAlbumPhotos(album: GPhotosAlbum, log: bunyan) {
    //     const cloudAlbumInfo = await album.getInfo();
    //     if (cloudAlbumInfo.itemsCount === 0) {
    //         log.info('no photos in album');
    //         return {};
    //     }
    //     log.info({ count: cloudAlbumInfo.itemsCount }, 'album already contain media');
    //     let cloudMedia: { [key: string]: boolean; } = {};
    //     while(true) {
    //         const res = await album.fetchPhotoList({ cursor: null });
    //         log.debug({ count: res.results.length }, 'found media items');
    //         for (const photo of res.results) {
    //             cloudMedia[photo.id] = true;
    //         }
    //         if (!res.nextCursor) {
    //             break;
    //         }
    //     }
    //     log.debug({ items: cloudMedia }, 'media items');

    //     return cloudMedia;
    // }

    private async uploadDirectory(directory: string) {
        log.info({ directory }, 'syncing directory');
        const directoryPath = path.resolve(this.source, directory);
        let album = await this.gphotos.searchAlbum({ title: directory });
        if (!album) {
            log.info("album doesn't exist, creating new one");
            album = await this.gphotos.createAlbum({ title: directory });
        } else {
            log.info('album already present, using it');
        }
        const albumSettings = new AlbumSettings(directoryPath);
        await albumSettings.loadSettings();

        // log.info('fetching media from album');
        // let cloudMedia = await this.fetchCloudAlbumPhotos(album, albumLog);
        
        const localMediaFiles = await this.getMediaFiles(directoryPath);
        log.info({ count: localMediaFiles.length }, 'found media files in directory');
        let ignored = 0;
        let added = 0;
        for (const file of localMediaFiles) {
            const filePath = path.resolve(directoryPath, file);
            const syncedFile = albumSettings.synced[file];
            if (syncedFile) {
                log.debug({ file }, 'file already present in album, ignoring');
                ignored++;
                continue;
            }
            log.info({ file }, 'uploading new file');
            const photo = await this.gphotos.upload({
                stream: fs.createReadStream(filePath),
                size: (await fs.promises.stat(filePath)).size,
                filename: this.generateFilename(file),
            });
            log.info({ file }, 'adding file to album');
            await album.append(photo);
            added++;
            albumSettings.updateSynced(file, photo.id);
        }
        log.info({ ignored, added }, 'directory synced');
    }

    async start() {
        await this.auth();

        const directories = await this.getDirectories(this.source);

        for (const directory of directories) {
            await this.uploadDirectory(directory);
        }
    }
}

const oneWaySync = new OneWaySync(process.argv[2]);
oneWaySync.start().catch((err: Error) => {
    log.error(err);
    process.exit(1);
});
