const db = require('./db');
const LogManager = require('../managers/LogManager');

async function initializeQueries() {
    try {
        // Create users table
        await db.query(`
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                name VARCHAR(255),
                email_verified BOOLEAN DEFAULT FALSE,
                email_verification_token VARCHAR(255),
                email_verification_expires DATETIME,
                password_reset_token VARCHAR(255),
                password_reset_expires DATETIME,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_email (email),
                INDEX idx_email_verification (email_verification_token),
                INDEX idx_password_reset (password_reset_token)
            )
        `);

        // Create roles table
        await db.query(`
            CREATE TABLE IF NOT EXISTS roles (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(50) NOT NULL UNIQUE,
                description TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_role_name (name)
            )
        `);

        // Create roles_hierarchy table for role inheritance
        await db.query(`
            CREATE TABLE IF NOT EXISTS roles_hierarchy (
                parent_role_id INT NOT NULL,
                child_role_id INT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (parent_role_id, child_role_id),
                FOREIGN KEY (parent_role_id) REFERENCES roles(id) ON DELETE CASCADE,
                FOREIGN KEY (child_role_id) REFERENCES roles(id) ON DELETE CASCADE,
                INDEX idx_parent_role (parent_role_id),
                INDEX idx_child_role (child_role_id)
            )
        `);

        // Create user_roles junction table
        await db.query(`
            CREATE TABLE IF NOT EXISTS user_roles (
                user_id INT NOT NULL,
                role_id INT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, role_id),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
            )
        `);

        // Create permissions table
        await db.query(`
            CREATE TABLE IF NOT EXISTS permissions (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(100) NOT NULL UNIQUE,
                description TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_permission_name (name)
            )
        `);

        // Create role_permissions junction table
        await db.query(`
            CREATE TABLE IF NOT EXISTS role_permissions (
                role_id INT NOT NULL,
                permission_id INT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (role_id, permission_id),
                FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
                FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
            )
        `);

        // Create audit log table
        await db.query(`
            CREATE TABLE IF NOT EXISTS auth_audit_log (
                id INT AUTO_INCREMENT PRIMARY KEY,
                action_type ENUM('role_assign', 'role_remove', 'permission_assign', 'permission_remove', 'role_create', 'role_delete'),
                admin_id INT NOT NULL,
                target_id INT NOT NULL,
                role_id INT,
                permission_id INT,
                metadata JSON,
                ip_address VARCHAR(45),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_action_type (action_type),
                INDEX idx_admin_id (admin_id),
                INDEX idx_target_id (target_id),
                INDEX idx_created_at (created_at),
                FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        // Create analytics tables
        await db.query(`
            CREATE TABLE IF NOT EXISTS role_analytics (
                id INT AUTO_INCREMENT PRIMARY KEY,
                role_id INT NOT NULL,
                total_users INT DEFAULT 0,
                total_actions INT DEFAULT 0,
                last_used TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
                INDEX idx_role_usage (role_id, total_actions)
            )
        `);

        await db.query(`
            CREATE TABLE IF NOT EXISTS permission_analytics (
                id INT AUTO_INCREMENT PRIMARY KEY,
                permission_id INT NOT NULL,
                total_uses INT DEFAULT 0,
                last_used TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE,
                INDEX idx_permission_usage (permission_id, total_uses)
            )
        `);

        // Insert default roles
        await db.query(`
            INSERT IGNORE INTO roles (name, description) VALUES 
            ('admin', 'Full system access'),
            ('moderator', 'Content moderation access'),
            ('user', 'Standard user access')
        `);

        // Insert default permissions
        await db.query(`
            INSERT IGNORE INTO permissions (name, description) VALUES 
            ('user:read', 'Read user information'),
            ('user:write', 'Create or update user information'),
            ('user:delete', 'Delete user accounts'),
            ('role:read', 'View roles'),
            ('role:write', 'Create or update roles'),
            ('role:delete', 'Delete roles'),
            ('permission:read', 'View permissions'),
            ('permission:write', 'Assign or remove permissions'),
            ('system:admin', 'Full system administration')
        `);

        // Set up initial role permissions
        const roles = await db.query('SELECT id, name FROM roles');
        const permissions = await db.query('SELECT id, name FROM permissions');

        const findByName = (array, name) => array.find(item => item.name === name);

        const adminRole = findByName(roles, 'admin');
        const moderatorRole = findByName(roles, 'moderator');
        const userRole = findByName(roles, 'user');

        if (adminRole && moderatorRole && userRole) {
            // Clear existing role_permissions to avoid duplicates
            await db.query('DELETE FROM role_permissions');

            // Admin gets all permissions
            for (const permission of permissions) {
                await db.query(
                    'INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
                    [adminRole.id, permission.id]
                );
            }

            // Moderator permissions
            const moderatorPermissions = ['user:read', 'role:read', 'permission:read'];
            for (const permission of permissions) {
                if (moderatorPermissions.includes(permission.name)) {
                    await db.query(
                        'INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
                        [moderatorRole.id, permission.id]
                    );
                }
            }

            // User permissions
            const userPermissions = ['user:read'];
            for (const permission of permissions) {
                if (userPermissions.includes(permission.name)) {
                    await db.query(
                        'INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
                        [userRole.id, permission.id]
                    );
                }
            }

            // Set up initial role hierarchy (admin > moderator > user)
            await db.query('DELETE FROM roles_hierarchy');
            
            // Admin is parent of moderator
            await db.query(
                'INSERT IGNORE INTO roles_hierarchy (parent_role_id, child_role_id) VALUES (?, ?)',
                [adminRole.id, moderatorRole.id]
            );
            
            // Moderator is parent of user
            await db.query(
                'INSERT IGNORE INTO roles_hierarchy (parent_role_id, child_role_id) VALUES (?, ?)',
                [moderatorRole.id, userRole.id]
            );
        }

        LogManager.success('Database tables and initial data initialized');
    } catch (error) {
        LogManager.error('Failed to initialize database tables', error);
        throw error;
    }
}

// Add role hierarchy queries to use with RoleManager
const roleHierarchyQueries = {
    async getChildRoles(roleId) {
        const roles = await db.query(
            `SELECT r.* FROM roles r
            JOIN roles_hierarchy rh ON r.id = rh.child_role_id
            WHERE rh.parent_role_id = ?`,
            [roleId]
        );
        return roles;
    },

    async getParentRoles(roleId) {
        const roles = await db.query(
            `SELECT r.* FROM roles r
            JOIN roles_hierarchy rh ON r.id = rh.parent_role_id
            WHERE rh.child_role_id = ?`,
            [roleId]
        );
        return roles;
    },

    async addChildRole(parentRoleId, childRoleId) {
        // Check for circular references before adding
        const isCircular = await this.wouldCreateCircularReference(parentRoleId, childRoleId);
        if (isCircular) {
            throw new Error('Adding this relationship would create a circular reference in the role hierarchy');
        }

        const result = await db.query(
            'INSERT IGNORE INTO roles_hierarchy (parent_role_id, child_role_id) VALUES (?, ?)',
            [parentRoleId, childRoleId]
        );
        return result;
    },

    async removeChildRole(parentRoleId, childRoleId) {
        const result = await db.query(
            'DELETE FROM roles_hierarchy WHERE parent_role_id = ? AND child_role_id = ?',
            [parentRoleId, childRoleId]
        );
        return result;
    },

    async wouldCreateCircularReference(parentRoleId, childRoleId) {
        if (parentRoleId === childRoleId) {
            return true; // Self-reference is circular
        }

        // Check if child is already an ancestor of the parent (which would create a loop)
        const ancestors = await this.getAllAncestors(parentRoleId);
        return ancestors.some(role => role.id === Number(childRoleId));
    },

    async getAllAncestors(roleId) {
        // Get all roles that are ancestors (direct or indirect parents) of the given role
        const ancestors = [];
        const queue = [roleId];
        const visited = new Set();

        while (queue.length > 0) {
            const currentId = queue.shift();
            
            if (visited.has(currentId)) continue;
            visited.add(currentId);

            const parents = await this.getParentRoles(currentId);
            
            for (const parent of parents) {
                ancestors.push(parent);
                queue.push(parent.id);
            }
        }

        return ancestors;
    },

    async getAllDescendants(roleId) {
        // Get all roles that are descendants (direct or indirect children) of the given role
        const descendants = [];
        const queue = [roleId];
        const visited = new Set();

        while (queue.length > 0) {
            const currentId = queue.shift();
            
            if (visited.has(currentId)) continue;
            visited.add(currentId);

            const children = await this.getChildRoles(currentId);
            
            for (const child of children) {
                descendants.push(child);
                queue.push(child.id);
            }
        }

        return descendants;
    }
};

const userQueries = {
    async createUser(userData) {
        const { email, password, name } = userData;
        const result = await db.query(
            'INSERT INTO users (email, password, name) VALUES (?, ?, ?)',
            [email, password, name]
        );
        return result;
    },

    async getUserByEmail(email) {
        const users = await db.query(
            'SELECT * FROM users WHERE email = ?',
            [email]
        );
        return users[0];
    },

    async getUserById(id) {
        const users = await db.query(
            'SELECT id, email, name, created_at FROM users WHERE id = ?',
            [id]
        );
        return users[0];
    },

    async updateUser(id, userData) {
        const { name, email } = userData;
        const result = await db.query(
            'UPDATE users SET name = ?, email = ? WHERE id = ?',
            [name, email, id]
        );
        return result;
    },

    async setVerificationToken(userId, token, expires) {
        const result = await db.query(
            'UPDATE users SET email_verification_token = ?, email_verification_expires = ? WHERE id = ?',
            [token, expires, userId]
        );
        return result;
    },

    async verifyEmail(token) {
        const users = await db.query(
            'SELECT id FROM users WHERE email_verification_token = ? AND email_verification_expires > NOW() AND email_verified = FALSE',
            [token]
        );
        
        if (users.length === 0) return null;

        await db.query(
            'UPDATE users SET email_verified = TRUE, email_verification_token = NULL, email_verification_expires = NULL WHERE id = ?',
            [users[0].id]
        );
        
        return users[0];
    },

    async setPasswordResetToken(userId, token, expires) {
        const result = await db.query(
            'UPDATE users SET password_reset_token = ?, password_reset_expires = ? WHERE id = ?',
            [token, expires, userId]
        );
        return result;
    },

    async getUserByResetToken(token) {
        const users = await db.query(
            'SELECT * FROM users WHERE password_reset_token = ? AND password_reset_expires > NOW()',
            [token]
        );
        return users[0];
    },

    async updatePassword(userId, password) {
        const result = await db.query(
            'UPDATE users SET password = ?, password_reset_token = NULL, password_reset_expires = NULL WHERE id = ?',
            [password, userId]
        );
        return result;
    },

    async getUsers(offset = 0, limit = 10) {
        const [users] = await db.query(
            'SELECT * FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?',
            [limit, offset]
        );
        return users;
    },

    async getUserCount() {
        const [[result]] = await db.query('SELECT COUNT(*) as count FROM users');
        return result.count;
    },

    async countUsersByRole(roleName) {
        const [[result]] = await db.query(`
            SELECT COUNT(DISTINCT ur.user_id) as count 
            FROM user_roles ur
            JOIN roles r ON ur.role_id = r.id
            WHERE r.name = ?
        `, [roleName]);
        return result.count;
    },

    async deleteUser(userId) {
        const [result] = await db.query(
            'DELETE FROM users WHERE id = ?',
            [userId]
        );
        return result.affectedRows > 0;
    }
};

module.exports = { initializeQueries, userQueries, roleHierarchyQueries };