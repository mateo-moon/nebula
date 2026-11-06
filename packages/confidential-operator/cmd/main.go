package main

import (
	"context"
	"flag"
	api "github.com/mateo-moon/nebula/packages/confidential-operator/api/v1alpha1"
	"github.com/mateo-moon/nebula/packages/confidential-operator/internal/controller"
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
	flag.BoolVar(&leader, "leader-elect", true, "Use a namespace-scoped Lease to serialize reconciliation")
	flag.StringVar(&probes, "health-probe-bind-address", ":8081", "Health and readiness listener")
	opts := zap.Options{}
	opts.BindFlags(flag.CommandLine)
	flag.Parse()
	ctrl.SetLogger(zap.New(zap.UseFlagOptions(&opts)))
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
	utilruntime.Must(mgr.AddHealthzCheck("healthz", healthz.Ping))
	utilruntime.Must(mgr.AddReadyzCheck("readyz", healthz.Ping))
	if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
		ctrl.Log.Error(err, "controller manager stopped")
		os.Exit(1)
	}
}
