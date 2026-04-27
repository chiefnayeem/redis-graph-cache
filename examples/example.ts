/**
 * Redis Schema Engine - Usage Example
 *
 * This example shows how to use the Redis Schema Engine with a simple
 * blog schema including posts, categories, users, and comments.
 */

import { RedisGraphCache, Schema } from '../src';

// Define your schema
const blogSchema = {
  // Entity schemas
  post: {
    type: 'entity' as const,
    id: 'id',
    key: (id: string | number) => `post:${id}`,
    fields: {
      title: { type: 'string' as const },
      content: { type: 'string' as const },
      createdAt: { type: 'string' as const },
      publishedAt: { type: 'string' as const },
    },
    relations: {
      category: { type: 'category', kind: 'one' as const },
      author: { type: 'user', kind: 'one' as const },
      comments: { type: 'comment', kind: 'many' as const },
    },
    ttl: 3600, // 1 hour
  },

  category: {
    type: 'entity' as const,
    id: 'id',
    key: (id: string | number) => `category:${id}`,
    fields: {
      name: { type: 'string' as const },
      slug: { type: 'string' as const },
      description: { type: 'string' as const },
    },
    ttl: 86400, // 24 hours
  },

  user: {
    type: 'entity' as const,
    id: 'id',
    key: (id: string | number) => `user:${id}`,
    fields: {
      name: { type: 'string' as const },
      email: { type: 'string' as const },
      avatar: { type: 'string' as const },
    },
    ttl: 7200, // 2 hours
  },

  comment: {
    type: 'entity' as const,
    id: 'id',
    key: (id: string | number) => `comment:${id}`,
    fields: {
      content: { type: 'string' as const },
      createdAt: { type: 'string' as const },
    },
    relations: {
      user: { type: 'user', kind: 'one' as const },
    },
    ttl: 1800, // 30 minutes
  },

  // List schemas
  postList: {
    type: 'list' as const,
    entityType: 'post',
    key: (page: number) => `posts:page:${page}`,
    idField: 'id',
    ttl: 600, // 10 minutes
  },

  categoryPosts: {
    type: 'list' as const,
    entityType: 'post',
    key: (categoryId: number, page: number) =>
      `posts:category:${categoryId}:page:${page}`,
    idField: 'id',
    ttl: 900, // 15 minutes
  },

  userPosts: {
    type: 'list' as const,
    entityType: 'post',
    key: (userId: number, page: number) => `posts:user:${userId}:page:${page}`,
    idField: 'id',
    ttl: 1200, // 20 minutes
  },
} satisfies Schema;

// Example usage
export async function exampleUsage() {
  // Initialize the engine
  const engine = new RedisGraphCache(blogSchema, {
    redis: {
      host: 'localhost',
      port: 6379,
    },
    limits: {
      maxHydrationDepth: 5,
      maxEntitiesPerRequest: 1000,
      maxMemoryUsagePerOperation: 50 * 1024 * 1024, // 50MB
      maxConcurrentOperations: 100,
      batchSize: 100,
    },
  });

  try {
    // Example data with nested relationships
    const postData = {
      id: 1,
      title: 'Understanding Redis Caching',
      content: 'Deep dive into caching strategies...',
      createdAt: '2026-04-26T10:00:00Z',
      publishedAt: '2026-04-26T10:00:00Z',

      category: {
        id: 5,
        name: 'Technology',
        slug: 'technology',
        description: 'Tech-related posts',
      },

      author: {
        id: 9,
        name: 'John Doe',
        email: 'john@example.com',
        avatar: 'https://example.com/avatar.jpg',
      },

      comments: [
        {
          id: 101,
          content: 'Great post!',
          createdAt: '2026-04-26T11:00:00Z',
          user: {
            id: 20,
            name: 'Jane Smith',
            email: 'jane@example.com',
            avatar: 'https://example.com/jane.jpg',
          },
        },
        {
          id: 102,
          content: 'Very informative, thanks!',
          createdAt: '2026-04-26T12:00:00Z',
          user: {
            id: 21,
            name: 'Bob Wilson',
            email: 'bob@example.com',
            avatar: 'https://example.com/bob.jpg',
          },
        },
      ],
    };

    // 1. Write entity (automatically normalizes and stores relationships)
    console.log('Writing post with nested relationships...');
    const writeResult = await engine.writeEntity('post', postData);
    console.log('Write result:', writeResult);

    // 2. Read entity (automatically hydrates relationships)
    console.log('\\nReading post with hydrated relationships...');
    const hydratedPost = await engine.readEntity('post', 1);
    console.log('Hydrated post:', JSON.stringify(hydratedPost, null, 2));

    // 3. Write a list of posts
    console.log('\\nWriting post list...');
    const postList = [
      {
        id: 1,
        title: 'Post 1',
        category: { id: 5, name: 'Tech' },
        author: { id: 9, name: 'John' },
      },
      {
        id: 2,
        title: 'Post 2',
        category: { id: 5, name: 'Tech' },
        author: { id: 10, name: 'Alice' },
      },
    ];

    const listResult = await engine.writeList(
      'postList',
      { page: 1 },
      postList,
    );
    console.log('List write result:', listResult);

    // 4. Update entity only if it exists (smart cache invalidation)
    console.log('\\nUpdating category only if cached...');
    const categoryUpdate = await engine.updateEntityIfExists('category', {
      id: 5,
      name: 'Technology & Innovation',
      slug: 'tech-innovation',
    });
    if (categoryUpdate) {
      console.log('Category was cached and updated');
    } else {
      console.log('Category was not in cache, skipped update');
    }

    // Try updating a non-existent entity
    console.log('\\nTrying to update non-cached entity...');
    const nonExistentUpdate = await engine.updateEntityIfExists('category', {
      id: 999,
      name: 'Non-existent Category',
      slug: 'non-existent',
    });
    console.log('Update result:', nonExistentUpdate); // null

    // 4. Read list (automatically hydrates all entities)
    console.log('\\nReading post list with hydrated entities...');
    const hydratedList = await engine.readList('postList', { page: 1 });
    console.log('Hydrated list:', JSON.stringify(hydratedList, null, 2));

    // 5. Update category (affects all posts that reference it)
    console.log('\\nUpdating category...');
    await engine.writeEntity('category', {
      id: 5,
      name: 'Advanced Technology', // Changed name
      slug: 'advanced-technology',
      description: 'Advanced tech topics',
    });

    // 6. Read post again (should show updated category name via hydration)
    console.log('\\nReading post after category update...');
    const updatedPost = await engine.readEntity('post', 1);
    console.log(
      'Post with updated category:',
      JSON.stringify(updatedPost.category, null, 2),
    );

    // 7. Add item to list (with entity data)
    console.log('\\nAdding new post to list...');
    const newPost = {
      id: 3,
      title: 'Post 3 - New Addition',
      content: 'This is a new post added to the list',
      category: { id: 5, name: 'Tech' },
      author: { id: 11, name: 'Charlie' },
      comments: [],
    };
    await engine.addListItem('postList', { page: 1 }, newPost);
    console.log('Added post 3 to list');

    // 8. Remove item from list (without deleting entity)
    console.log('\\nRemoving post 2 from list (keeping entity in cache)...');
    await engine.removeListItem('postList', { page: 1 }, 2);
    console.log('Removed post 2 from list');

    // 9. Remove item from list AND delete entity
    console.log('\\nRemoving post 3 from list and deleting entity...');
    await engine.removeListItem('postList', { page: 1 }, 3, {
      deleteEntity: true,
    });
    console.log('Removed post 3 from list and deleted from cache');

    // 10. Verify list after modifications
    console.log('\\nReading list after modifications...');
    const modifiedList = await engine.readList('postList', { page: 1 });
    console.log(
      'Modified list:',
      modifiedList.map((p: any) => ({ id: p.id, title: p.title })),
    );

    // 11. Get metrics
    console.log('\\nEngine metrics:');
    const metrics = engine.getMetrics();
    console.log(metrics);

    // 12. Get health status
    console.log('\\nHealth status:');
    const health = await engine.getHealthStatus();
    console.log(health);
  } catch (error) {
    console.error('Error:', error);
  } finally {
    // Clean up
    await engine.disconnect();
  }
}

// Uncomment to run the example
// exampleUsage().catch(console.error);
