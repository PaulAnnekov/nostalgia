import fs from 'fs';
import path from 'path';
import { GPhotos } from 'upload-gphotos';
import { CookieJar, Cookie } from 'tough-cookie';
import config from './config.json';

process.on('unhandledRejection', (err) => {
    console.error(err);
    process.exit(2);
}).on('uncaughtException', (err) => {
    console.error(err);
    process.exit(3);
});

class OneWaySync {
    private readonly APP_NAME = 'Nostalgia';
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
            console.error(`Failed to login.`);
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
    
    private async getFiles(source: string) {
        const entities = await fs.promises.readdir(source, { withFileTypes: true });
        return entities.filter(entity => entity.isFile()).map(entity => entity.name);
    }

    private async uploadDirectory(directory: string) {
        console.info(`syncing directory "${directory}"`);
        let album = await this.gphotos.searchAlbum({ title: directory });
        let isNew = false;
        if (!album) {
            console.info(`album "${directory}" doesn't exist, creating new one`);
            album = await this.gphotos.createAlbum({ title: directory });
            isNew = true;
        } else {
            console.info(`album "${directory}" already present, using it`);
        }
        let photos: { [key: string]: boolean; } = {};
        console.info(`fetching photos from existing album`);
        while(!isNew) {
            const res = await album.fetchPhotoList({ cursor: null });
            console.debug(`found ${res.results.length} media items`);
            for (const photo of res.results) {
                const info = await photo.getInfo({ force: true });
                if (photos[info.title]) {
                    console.warn(`photo with title ${info.title} present twice in a single album`, info);
                }
                photos[info.title] = true;
            }
            if (!res.nextCursor) {
                break;
            }
        }
        console.info(`total existing items: ${Object.keys(photos).length}`);
        const files = await this.getFiles(path.resolve(this.source, directory));
        console.info(`found ${files.length} files in directory`);
        for (const file of files) {
            // TODO: check if media file
            const filePath = path.resolve(this.source, directory, file);
            const title = this.generateFilename(file);
            if (photos[title]) {
                console.debug(`file "${file}" already present in album, ignoring`);
                continue;
            }
            console.info(`uploading new file "${file}"`);
            const photo = await this.gphotos.upload({
                stream: fs.createReadStream(filePath),
                size: (await fs.promises.stat(filePath)).size,
                filename: title,
            });
            console.info(`adding file "${file}" to album`);
            await album.append(photo);
        }
    }

    async start() {
        await this.auth();

        const directories = await this.getDirectories(this.source);

        for (const directory of directories) {
            await this.uploadDirectory(directory);
            break;
        }
    }
}

const oneWaySync = new OneWaySync(process.argv[2]);
oneWaySync.start().catch((err: Error) => {
    console.error(err);
    process.exit(1);
});
