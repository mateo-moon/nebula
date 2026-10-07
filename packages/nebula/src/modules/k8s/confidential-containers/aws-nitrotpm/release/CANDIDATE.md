This is a software build candidate for the reusable AWS CoCo module. The disks,
publisher clients and OCI images are immutable inputs to hardware qualification.

A successful build does not qualify confidential execution, boot-time policy
enforcement, authority replication or recovery on AWS. The Nebula package must
pin a candidate only after those checks pass. No live guest PCR may replace a
build-derived measurement, and no customer workload key belongs in this release.
