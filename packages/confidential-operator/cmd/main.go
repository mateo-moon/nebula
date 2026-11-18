package main

import (
	"context"
	"flag"
	api "github.com/mateo-moon/nebula/packages/confidential-operator/api/v1alpha1"
	"github.com/mateo-moon/nebula/packages/confidential-operator/internal/controller"
	"github.com/mateo-moon/nebula/packages/confidential-operator/internal/imagestore"
	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"net/http"
	"os"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	"sigs.k8s.io/controller-runtime/pkg/manager"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"
	"strings"
	"time"
)

func main() {
	var leader bool
	var probes string
	var configureRegistryHosts bool
	var imageStoreAuthority, imageStoreHostsDirectory string
	flag.BoolVar(&leader, "leader-elect", true, "Use a namespace-scoped Lease to serialize reconciliation")
	flag.StringVar(&probes, "health-probe-bind-address", ":8081", "Health and readiness listener")
	flag.BoolVar(&configureRegistryHosts, "configure-image-store-registry-hosts", false, "Configure only the mounted image store registry authority, then exit")
	flag.StringVar(&imageStoreAuthority, "image-store-authority", "", "Exact private image store Service authority for native registry reads")
	flag.StringVar(&imageStoreHostsDirectory, "image-store-hosts-directory", "", "Exact authority directory mounted only into registry configuration init")
	opts := zap.Options{}
	opts.BindFlags(flag.CommandLine)
	flag.Parse()
	ctrl.SetLogger(zap.New(zap.UseFlagOptions(&opts)))
	if configureRegistryHosts {
		if err := imagestore.ConfigureRegistryHosts(imageStoreAuthority, os.Getenv("CONFIDENTIAL_OPERATOR_IMAGES_SERVICE_HOST"), imageStoreHostsDirectory); err != nil {
			ctrl.Log.Error(err, "cannot configure image store registry hosts")
			os.Exit(1)
		}
		return
	}
	if imageStoreHostsDirectory != "" {
		ctrl.Log.Error(nil, "registry hosts directory is only valid in one-shot configuration mode")
		os.Exit(1)
	}
	imageStore, err := imagestore.ConfigFromEnv(os.Getenv)
	if err != nil || (imageStoreAuthority != "" && (imageStore == nil || imagestore.ValidateRegistryAuthority(imageStoreAuthority) != nil)) {
		ctrl.Log.Error(nil, "invalid image store configuration or authority")
		os.Exit(1)
	}
	if imageStore != nil {
		imageStore.Authority = imageStoreAuthority
	}
	names := strings.Split(os.Getenv("WATCH_NAMESPACES"), ",")
	if err := controller.ValidateNamespaces(names); err != nil {
		ctrl.Log.Error(err, "invalid namespace scope")
		os.Exit(1)
	}
	namespace := os.Getenv("POD_NAMESPACE")
	if controller.ValidateNamespaces([]string{namespace}) != nil {
		ctrl.Log.Error(nil, "POD_NAMESPACE is required")
		os.Exit(1)
	}
	scoped := map[string]cache.Config{}
	for _, n := range names {
		scoped[n] = cache.Config{}
	}
	scheme := runtime.NewScheme()
	utilruntime.Must(clientgoscheme.AddToScheme(scheme))
	utilruntime.Must(api.AddToScheme(scheme))
	mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{Scheme: scheme, Cache: cache.Options{DefaultNamespaces: scoped, ReaderFailOnMissingInformer: true}, Metrics: metricsserver.Options{BindAddress: "0"}, HealthProbeBindAddress: probes, LeaderElection: leader, LeaderElectionID: "confidential-workloads.nebula.dev", LeaderElectionNamespace: namespace})
	if err != nil {
		ctrl.Log.Error(err, "cannot start controller manager")
		os.Exit(1)
	}
	renderer := controller.CommandRenderer{Command: "/usr/local/bin/node", Args: []string{"/app/dist/main.mjs"}}
	if err := (&controller.WorkloadReconciler{Client: mgr.GetClient(), Reader: mgr.GetAPIReader(), Scheme: scheme, Renderer: renderer}).SetupWithManager(mgr); err != nil {
		ctrl.Log.Error(err, "cannot initialize workload controller")
		os.Exit(1)
	}
	if err := (&controller.StorageReconciler{Client: mgr.GetClient(), Reader: mgr.GetAPIReader(), Renderer: renderer}).SetupWithManager(mgr); err != nil {
		ctrl.Log.Error(err, "cannot initialize storage controller")
		os.Exit(1)
	}
	if os.Getenv("ACCESS_LINKS") == "true" {
		server := &http.Server{Addr: ":8083", Handler: controller.AccessManager{Client: mgr.GetClient(), Reader: mgr.GetAPIReader(), Namespaces: names},
			ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 15 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8192}
		utilruntime.Must(mgr.Add(manager.RunnableFunc(func(ctx context.Context) error {
			go func() {
				<-ctx.Done()
				shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				_ = server.Shutdown(shutdown)
			}()
			if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				return err
			}
			return nil
		})))
	}
	if imageStore != nil {
		store, err := imagestore.New(*imageStore)
		if err != nil {
			ctrl.Log.Error(err, "cannot initialize ciphertext image store")
			os.Exit(1)
		}
		utilruntime.Must(mgr.Add(manager.RunnableFunc(store.Start)))
	}
	utilruntime.Must(mgr.AddHealthzCheck("healthz", healthz.Ping))
	utilruntime.Must(mgr.AddReadyzCheck("readyz", healthz.Ping))
	if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
		ctrl.Log.Error(err, "controller manager stopped")
		os.Exit(1)
	}
}
