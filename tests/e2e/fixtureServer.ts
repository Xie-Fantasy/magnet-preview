import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export async function listenFixture(server: Server): Promise<AddressInfo> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = 20_000 + Math.floor(Math.random() * 30_000);
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once('error', onError);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', onError);
          resolve();
        });
      });
      const address = server.address();
      if (address && typeof address !== 'string') return address;
      throw new Error('fixture address');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error('No local fixture port available');
}
