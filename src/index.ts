import fs from 'fs';
import path from 'path';
import { GPhotos, GPhotosAlbum } from 'upload-gphotos';
import { CookieJar, Cookie } from 'tough-cookie';
import config from './config.json';
import bunyan, { LogLevel } from 'bunyan';
import queue from 'queue';
import { promisify } from 'util';

const log = bunyan.createLogger({ 
    name: 'nostalgia',
    serializers: bunyan.stdSerializers,
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
    private savePromise: Promise<void> | null;
    private id: string;
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
        this.id = settings.id;
    }

    private async save() {
        if (this.savePromise) {
            await this.savePromise;
            await this.save();
            return;
        }
        this.savePromise = fs.promises.writeFile(this.path, JSON.stringify({
            id: this.id,
            synced: this.synced
        }));
        await this.savePromise;
        this.savePromise = null;
    }

    async updateId(id: string) {
        log.debug({ path: this.path }, 'updating album id in local settings');
        this.id = id;
        await this.save();
    }

    async updateSynced(name: string, id: string) {
        log.debug({ path: this.path }, 'updating synced list in local settings');
        this.synced[name] = { id };
        await this.save();
    }
}

class UploadQueue {
    private readonly CONCURRENCY = 5;
    private readonly MAX_CONSECUTIVE_ERRORS = 10;
    private readonly FIRST_COOLDOWN = 10000;
    private readonly queue: queue;
    private consecutiveErrors = 0;
    private cooldownTimer: NodeJS.Timeout | null;
    private cooldown = this.FIRST_COOLDOWN;

    constructor() {
        this.queue = new queue({
            concurrency: this.CONCURRENCY
        });
    }

    get length() {
        return this.queue.length;
    }

    execute() {
        return promisify(this.queue.start).bind(this.queue)();
    }

    addJob(file: string, job: () => Promise<any>) {
        this.queue.push(async () => {
            try {
                await job();
                this.consecutiveErrors = 0;
                this.cooldown = this.FIRST_COOLDOWN;
            } catch(err) {
                this.addJob(file, job);
                this.consecutiveErrors++;
                const isFinal = this.consecutiveErrors > this.MAX_CONSECUTIVE_ERRORS;
                // too verbose shit, removing
                delete err.config;
                log.warn({ err, file, isFinal }, 'error during upload/append to album');
                if (isFinal && !this.cooldownTimer) {
                    log.info({ cooldownSeconds: this.cooldown / 1000 }, "too much errors, let's wait a bit");
                    this.queue.stop();
                    this.cooldownTimer = setTimeout(() => {
                        this.cooldownTimer = null;
                        this.queue.start();
                    }, this.cooldown);
                    this.cooldown *= 2;
                }
            }
        })
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
        return `(${this.APP_NAME} App) ${path.basename(realName)}`;
    }

    private async getDirectories(source: string) {
        const entities = await fs.promises.readdir(source, { withFileTypes: true });
        return entities.filter(entity => entity.isDirectory()).map(entity => entity.name);
    }
    
    private async getMediaFiles(source: string, subFolder = '') {
        let files: string[] = [];
        const entities = await fs.promises.readdir(path.resolve(source, subFolder), { withFileTypes: true });
        for (const entity of entities) {
            const subPath = path.join(subFolder, entity.name);
            if (entity.isFile() && this.SUPPORTED_TYPES.includes(path.extname(entity.name).slice(1).toUpperCase())) {
                if ((await fs.promises.stat(path.resolve(source, subFolder, entity.name))).size == 0) {
                    log.debug({ file: subPath }, 'zero-length file');
                    continue;
                }
                files.push(subPath);
            } else if (entity.isDirectory()) {
                files = files.concat(await this.getMediaFiles(source, subPath));
            }
        }
        return files;
    }

    private async uploadDirectory(directory: string) {
        log.info({ directory }, 'syncing directory');
        const directoryPath = path.resolve(this.source, directory);
        // TODO: search by id in nostalgia.json
        let album = await this.gphotos.searchAlbum({ title: directory });
        if (!album) {
            log.info("album doesn't exist, creating new one");
            album = await this.gphotos.createAlbum({ title: directory });
        } else {
            log.info('album already present, using it');
        }
        const albumSettings = new AlbumSettings(directoryPath);
        await albumSettings.loadSettings();
        await albumSettings.updateId(album.id);
        
        const localMediaFiles = await this.getMediaFiles(directoryPath);
        log.info({ count: localMediaFiles.length }, 'found media files in directory');
        let ignored = 0;
        let added = 0;
        let uploadedBytes = 0;
        const uploadQueue = new UploadQueue();
        for (const file of localMediaFiles) {
            const filePath = path.resolve(directoryPath, file);
            const syncedFile = albumSettings.synced[file];
            if (syncedFile) {
                log.debug({ file }, 'file already present in album, ignoring');
                ignored++;
                continue;
            }
            uploadQueue.addJob(file, async () => {
                const size = (await fs.promises.stat(filePath)).size;
                log.info({ file, size }, 'uploading new file');
                const photo = await this.gphotos.upload({
                    stream: fs.createReadStream(filePath),
                    size,
                    filename: this.generateFilename(file),
                });
                log.info({ file }, 'adding file to album');
                await (album as GPhotosAlbum).append(photo);
                uploadedBytes += size;
                added++;
                await albumSettings.updateSynced(file, photo.id);
            });
        }
        log.info({ count: uploadQueue.length }, 'starting uploads');
        await uploadQueue.execute();
        // TODO: remove files in cloud that are removed locally
        log.info({ ignored, added, uploadedBytes }, 'directory synced');
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
