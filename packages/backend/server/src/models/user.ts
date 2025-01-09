import { Injectable, Logger } from '@nestjs/common';
import { Prisma, PrismaClient, type User, Workspace } from '@prisma/client';
import { pick } from 'lodash-es';

import {
  Config,
  CryptoHelper,
  EmailAlreadyUsed,
  EventEmitter,
  type EventPayload,
  OnEvent,
  WrongSignInCredentials,
  WrongSignInMethod,
} from '../base';
import type { Payload } from '../base/event/def';
import { Permission } from '../core/permission';
import { Quota_FreePlanV1_1 } from '../core/quota';

const publicUserSelect = {
  id: true,
  name: true,
  email: true,
  avatarUrl: true,
} satisfies Prisma.UserSelect;
type CreateUserInput = Omit<Prisma.UserCreateInput, 'name'> & { name?: string };
type UpdateUserInput = Omit<Partial<Prisma.UserCreateInput>, 'id'>;

const defaultUserCreatingData = {
  name: 'Unnamed',
  // TODO(@forehalo): it's actually a external dependency for user
  // how could we avoid user model's knowledge of feature?
  features: {
    create: {
      reason: 'sign up',
      activated: true,
      feature: {
        connect: {
          feature_version: Quota_FreePlanV1_1,
        },
      },
    },
  },
};

declare module '../base/event/def' {
  interface UserEvents {
    created: Payload<User>;
    updated: Payload<User>;
    deleted: Payload<
      User & {
        // TODO(@forehalo): unlink foreign key constraint on [WorkspaceUserPermission] to delegate
        // dealing of owned workspaces of deleted users to workspace model
        ownedWorkspaces: Workspace['id'][];
      }
    >;
  }

  interface EventDefinitions {
    user: UserEvents;
  }
}

export type PublicUser = Pick<User, keyof typeof publicUserSelect>;
export type { User };

@Injectable()
export class UserModel {
  private readonly logger = new Logger(UserModel.name);
  constructor(
    private readonly db: PrismaClient,
    private readonly crypto: CryptoHelper,
    private readonly event: EventEmitter,
    private readonly config: Config
  ) {}

  async get(id: string) {
    return this.db.user.findUnique({
      where: { id },
    });
  }

  async getPublicUser(id: string): Promise<PublicUser | null> {
    return this.db.user.findUnique({
      select: publicUserSelect,
      where: { id },
    });
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const rows = await this.db.$queryRaw<User[]>`
      SELECT id, name, email, password, registered, email_verified as emailVerifiedAt, avatar_url as avatarUrl, registered, created_at as createdAt
      FROM "users"
      WHERE lower("email") = lower(${email})
    `;

    return rows[0] ?? null;
  }

  async signIn(email: string, password: string): Promise<User> {
    const user = await this.getUserByEmail(email);

    if (!user) {
      throw new WrongSignInCredentials({ email });
    }

    if (!user.password) {
      throw new WrongSignInMethod();
    }

    const passwordMatches = await this.crypto.verifyPassword(
      password,
      user.password
    );

    if (!passwordMatches) {
      throw new WrongSignInCredentials({ email });
    }

    return user;
  }

  async getPublicUserByEmail(email: string): Promise<PublicUser | null> {
    const rows = await this.db.$queryRaw<PublicUser[]>`
      SELECT id, name, email, avatar_url as avatarUrl
      FROM "users"
      WHERE lower("email") = lower(${email})
    `;

    return rows[0] ?? null;
  }

  toPublicUser(user: User): PublicUser {
    return pick(user, Object.keys(publicUserSelect)) as any;
  }

  async create(data: CreateUserInput) {
    let user = await this.getUserByEmail(data.email);

    if (user) {
      throw new EmailAlreadyUsed();
    }

    if (data.password) {
      data.password = await this.crypto.encryptPassword(data.password);
    }

    if (!data.name) {
      data.name = data.email.split('@')[0];
    }

    user = await this.db.user.create({
      data: {
        ...defaultUserCreatingData,
        ...data,
      },
    });

    this.logger.debug(`User [${user.id}] created with email [${user.email}]`);
    this.event.emit('user.created', user);

    return user;
  }

  async update(id: string, data: UpdateUserInput) {
    if (data.password) {
      data.password = await this.crypto.encryptPassword(data.password);
    }

    if (data.email) {
      const user = await this.getUserByEmail(data.email);
      if (user && user.id !== id) {
        throw new EmailAlreadyUsed();
      }
    }

    const user = await this.db.user.update({
      where: { id },
      data,
    });

    this.logger.debug(`User [${user.id}] updated`);
    this.event.emit('user.updated', user);
    return user;
  }

  /**
   * Mark a existing user or create a new one as registered and email verified.
   *
   * When user created by others invitation, we will leave it as unregistered.
   */
  async fulfill(email: string, data: Omit<UpdateUserInput, 'email'> = {}) {
    const user = await this.getUserByEmail(email);

    if (!user) {
      return this.create({
        email,
        registered: true,
        emailVerifiedAt: new Date(),
        ...data,
      });
    } else {
      if (user.registered) {
        delete data.registered;
      } else {
        data.registered = true;
      }

      if (user.emailVerifiedAt) {
        delete data.emailVerifiedAt;
      } else {
        data.emailVerifiedAt = new Date();
      }

      if (Object.keys(data).length) {
        return await this.update(user.id, data);
      }
    }

    return user;
  }

  async delete(id: string) {
    const ownedWorkspaces = await this.db.workspaceUserPermission.findMany({
      where: {
        userId: id,
        type: Permission.Owner,
      },
    });

    const user = await this.db.user.delete({ where: { id } });

    this.event.emit('user.deleted', {
      ...user,
      ownedWorkspaces: ownedWorkspaces.map(w => w.workspaceId),
    });

    return user;
  }

  async pagination(skip: number = 0, take: number = 20, after?: Date) {
    return this.db.user.findMany({
      where: {
        createdAt: {
          gt: after,
        },
      },
      orderBy: {
        createdAt: 'asc',
      },
      skip,
      take,
    });
  }

  async count() {
    return this.db.user.count();
  }

  @OnEvent('user.updated')
  async onUserUpdated(user: EventPayload<'user.updated'>) {
    const { enabled, customerIo } = this.config.metrics;
    if (enabled && customerIo?.token) {
      const payload = {
        name: user.name,
        email: user.email,
        created_at: Number(user.createdAt) / 1000,
      };
      try {
        await fetch(`https://track.customer.io/api/v1/customers/${user.id}`, {
          method: 'PUT',
          headers: {
            Authorization: `Basic ${customerIo.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });
      } catch (e) {
        this.logger.error('Failed to publish user update event:', e);
      }
    }
  }

  @OnEvent('user.deleted')
  async onUserDeleted(user: EventPayload<'user.deleted'>) {
    const { enabled, customerIo } = this.config.metrics;
    if (enabled && customerIo?.token) {
      try {
        if (user.emailVerifiedAt) {
          // suppress email if email is verified
          await fetch(
            `https://track.customer.io/api/v1/customers/${user.email}/suppress`,
            {
              method: 'POST',
              headers: {
                Authorization: `Basic ${customerIo.token}`,
              },
            }
          );
        }
        await fetch(`https://track.customer.io/api/v1/customers/${user.id}`, {
          method: 'DELETE',
          headers: { Authorization: `Basic ${customerIo.token}` },
        });
      } catch (e) {
        this.logger.error('Failed to publish user delete event:', e);
      }
    }
  }
}