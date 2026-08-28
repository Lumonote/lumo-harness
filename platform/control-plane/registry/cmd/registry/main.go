// Command registry 是制品注册表服务。
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/lumo-harness/platform/observability"
	"github.com/lumo-harness/platform/registry/internal/objstore"
	"github.com/lumo-harness/platform/registry/internal/server"
	"github.com/lumo-harness/platform/registry/internal/store"
	"github.com/lumo-harness/platform/registry/internal/trust"
)

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func main() {
	ctx := context.Background()

	dsn := os.Getenv("REGISTRY_PG_DSN")
	if dsn == "" {
		log.Fatal("registry: 必须设置 REGISTRY_PG_DSN")
	}
	trustFile := os.Getenv("REGISTRY_TRUST_FILE")
	if trustFile == "" {
		log.Fatal("registry: 必须设置 REGISTRY_TRUST_FILE —— 信任根在配置文件，不在数据库")
	}
	ts, err := trust.LoadFile(trustFile)
	if err != nil {
		log.Fatalf("registry: 加载信任表失败: %v", err)
	}

	var objs objstore.Store
	if ep := os.Getenv("REGISTRY_S3_ENDPOINT"); ep != "" {
		useSSL, _ := strconv.ParseBool(env("REGISTRY_S3_SSL", "false"))
		s3, serr := objstore.NewS3Store(ep,
			os.Getenv("REGISTRY_S3_ACCESS_KEY"), os.Getenv("REGISTRY_S3_SECRET_KEY"),
			env("REGISTRY_S3_BUCKET", "lumo-registry"), useSSL)
		if serr != nil {
			log.Fatalf("registry: 连对象存储失败: %v", serr)
		}
		objs = s3
	} else {
		// Local-lite 形态：本地文件内容寻址，无需 MinIO。
		objs = objstore.NewFileStore(env("REGISTRY_LOCAL_ROOT", "/var/lib/registry/objects"))
		log.Printf("registry: 未设 REGISTRY_S3_ENDPOINT，使用本地对象存储")
	}

	s, err := store.New(ctx, dsn, objs, ts)
	if err != nil {
		log.Fatalf("registry: 连库失败: %v", err)
	}
	defer s.Close()
	if err := s.Init(ctx); err != nil {
		log.Fatalf("registry: 建表失败: %v", err)
	}

	addr := ":" + env("REGISTRY_PORT", "8084")
	srv := &http.Server{
		Addr:              addr,
		Handler:           observability.Middleware(observability.RequireControlPlaneToken(os.Getenv("LUMO_CONTROL_PLANE_TOKEN"))(server.New(s, ts, objs))),
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("registry: 监听 %s", addr)
	if err := srv.ListenAndServe(); err != nil {
		log.Fatalf("registry: 服务退出: %v", err)
	}
}
