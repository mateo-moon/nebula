package main

import (
	"flag"
	api "github.com/mateo-moon/nebula/packages/confidential-operator/api/v1alpha1"
	"github.com/mateo-moon/nebula/packages/confidential-operator/internal/controller"
	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"os"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"
	"strings"
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
	renderer := controller.CommandRenderer{Command: "/app/node_modules/.bin/tsx", Args: []string{"/app/src/main.ts"}}
	if err := (&controller.WorkloadReconciler{Client: mgr.GetClient(), Reader: mgr.GetAPIReader(), Scheme: scheme, Renderer: renderer}).SetupWithManager(mgr); err != nil {
		ctrl.Log.Error(err, "cannot initialize workload controller")
		os.Exit(1)
	}
	if err := (&controller.StorageReconciler{Client: mgr.GetClient(), Reader: mgr.GetAPIReader(), Renderer: renderer}).SetupWithManager(mgr); err != nil {
		ctrl.Log.Error(err, "cannot initialize storage controller")
		os.Exit(1)
	}
	utilruntime.Must(mgr.AddHealthzCheck("healthz", healthz.Ping))
	utilruntime.Must(mgr.AddReadyzCheck("readyz", healthz.Ping))
	if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
		ctrl.Log.Error(err, "controller manager stopped")
		os.Exit(1)
	}
}
