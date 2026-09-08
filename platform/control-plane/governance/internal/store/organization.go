package store

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/lumo-harness/platform/governance/internal/domain"
)

func (s *Store) UpdateRole(ctx context.Context, role domain.Role, actor string) (domain.Role, error) {
	role.Name = strings.TrimSpace(role.Name)
	if !managedID.MatchString(role.ID) || role.Name == "" || len([]rune(role.Name)) > 160 || len([]rune(role.Description)) > 500 || !validOrgStatus(role.Status) {
		return domain.Role{}, fmt.Errorf("%w: invalid role", ErrBadRequest)
	}
	tx, err := s.beginOrganizationChange(ctx, role.Realm)
	if err != nil {
		return domain.Role{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	before, err := s.activeAdminCount(ctx, tx, role.Realm)
	if err != nil {
		return domain.Role{}, err
	}
	tag, err := tx.Exec(ctx, `UPDATE governance_roles SET name=$3,description=$4,status=$5 WHERE realm=$1 AND id=$2`, role.Realm, role.ID, role.Name, role.Description, role.Status)
	if isUniqueViolation(err) {
		return domain.Role{}, ErrConflict
	}
	if err != nil {
		return domain.Role{}, err
	}
	if tag.RowsAffected() == 0 {
		return domain.Role{}, ErrNotFound
	}
	if err := s.preserveActiveAdmin(ctx, tx, role.Realm, before); err != nil {
		return domain.Role{}, err
	}
	if err := recordUserAdminEvent(ctx, tx, role.Realm, actor, "role_updated", actor, map[string]any{"role_id": role.ID, "status": role.Status}); err != nil {
		return domain.Role{}, err
	}
	return role, tx.Commit(ctx)
}

func (s *Store) UpdateDepartment(ctx context.Context, department domain.Department, actor string) (domain.Department, error) {
	department.Name = strings.TrimSpace(department.Name)
	if !managedID.MatchString(department.ID) || department.Name == "" || len([]rune(department.Name)) > 160 || !validOrgStatus(department.Status) {
		return domain.Department{}, fmt.Errorf("%w: invalid department", ErrBadRequest)
	}
	tx, err := s.beginOrganizationChange(ctx, department.Realm)
	if err != nil {
		return domain.Department{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var oldPath string
	var oldLevel int
	err = tx.QueryRow(ctx, `SELECT path,level FROM governance_departments WHERE realm=$1 AND id=$2 FOR UPDATE`, department.Realm, department.ID).Scan(&oldPath, &oldLevel)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Department{}, ErrNotFound
	}
	if err != nil {
		return domain.Department{}, err
	}
	parentPath := "/"
	department.Level = 0
	if department.ParentDeptID != "" {
		var parentLevel int
		err = tx.QueryRow(ctx, `SELECT path,level FROM governance_departments WHERE realm=$1 AND id=$2 AND status='active'`, department.Realm, department.ParentDeptID).Scan(&parentPath, &parentLevel)
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.Department{}, fmt.Errorf("%w: parent department must be active in this realm", ErrBadRequest)
		}
		if err != nil {
			return domain.Department{}, err
		}
		if strings.HasPrefix(parentPath, oldPath) {
			return domain.Department{}, fmt.Errorf("%w: department hierarchy cannot contain a cycle", ErrBadRequest)
		}
		department.Level = parentLevel + 1
	}
	if department.ManagerUserID != "" {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM governance_users WHERE realm=$1 AND id=$2 AND status='active')`, department.Realm, department.ManagerUserID).Scan(&exists); err != nil {
			return domain.Department{}, err
		}
		if !exists {
			return domain.Department{}, fmt.Errorf("%w: manager must be an active user in this realm", ErrBadRequest)
		}
	}
	if department.Status == "disabled" {
		var occupied bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM governance_departments WHERE realm=$1 AND parent_dept_id=$2 AND status='active')
			OR EXISTS(SELECT 1 FROM governance_users WHERE realm=$1 AND primary_dept_id=$2 AND status='active')`, department.Realm, department.ID).Scan(&occupied); err != nil {
			return domain.Department{}, err
		}
		if occupied {
			return domain.Department{}, fmt.Errorf("%w: move active users and child departments before disabling this department", ErrBadRequest)
		}
	}
	department.Path = parentPath + department.ID + "/"
	_, err = tx.Exec(ctx, `UPDATE governance_departments SET name=$3,parent_dept_id=$4,manager_user_id=$5,status=$6 WHERE realm=$1 AND id=$2`, department.Realm, department.ID, department.Name, department.ParentDeptID, department.ManagerUserID, department.Status)
	if isUniqueViolation(err) {
		return domain.Department{}, ErrConflict
	}
	if err != nil {
		return domain.Department{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE governance_departments SET path=$3 || substring(path FROM length($2)+1),level=level+$4
		WHERE realm=$1 AND left(path,length($2))=$2`, department.Realm, oldPath, department.Path, department.Level-oldLevel); err != nil {
		return domain.Department{}, err
	}
	if err = recordUserAdminEvent(ctx, tx, department.Realm, actor, "department_updated", actor, map[string]any{"department_id": department.ID, "status": department.Status, "parent_dept_id": department.ParentDeptID}); err != nil {
		return domain.Department{}, err
	}
	return department, tx.Commit(ctx)
}
